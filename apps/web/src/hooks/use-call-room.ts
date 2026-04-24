import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import { createInitialCallState, reduceCallState } from '../features/call/call-state';
import {
  ensureMediaStream,
  getTrackByKind,
  removeTrackFromStream,
  replaceTrackInStream,
  setTrackEnabled
} from '../features/call/local-media';
import type {
  ChatMessage,
  DeviceLists,
  Participant,
  RemoteMediaState,
  RoomPolicy,
  WireParticipant
} from '../features/call/types';

type JoinForm = {
  roomId: string;
  displayName: string;
};

type JoinAck =
  | {
      ok: true;
      participantId: string;
      roomId: string;
      participants: WireParticipant[];
      chatMessages: ChatMessage[];
      policy: RoomPolicy;
    }
  | { ok: false; error: string };

type SignalPayload =
  | { type: 'offer' | 'answer'; payload: RTCSessionDescriptionInit }
  | { type: 'candidate'; payload: RTCIceCandidateInit };

type PeerRecord = {
  pc: RTCPeerConnection;
  polite: boolean;
  makingOffer: boolean;
  ignoreOffer: boolean;
  isSettingRemoteAnswerPending: boolean;
  senders: {
    cameraVideo?: RTCRtpSender;
    cameraAudio?: RTCRtpSender;
    screenVideo?: RTCRtpSender;
    screenAudio?: RTCRtpSender;
  };
};

type SpeakingMonitorCleanup = () => void;
type SpeakingSource = 'camera' | 'screen';

const rtcConfig: RTCConfiguration = {
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
};

const emptyDevices: DeviceLists = {
  audioInputs: [],
  videoInputs: [],
  audioOutputs: []
};

const serverUrl =
  import.meta.env.VITE_SERVER_URL ?? (typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3001');

const SPEAKING_THRESHOLD = 0.06;
const SPEAKING_ENTER_MS = 120;
const SPEAKING_LEAVE_MS = 420;
const ANALYSER_FFT_SIZE = 512;
const ANALYSER_SMOOTHING = 0.82;

const cloneRemoteMap = (source: Map<string, RemoteMediaState>) =>
  new Map([...source.entries()].map(([key, value]) => [key, { ...value }]));

const createSpeakingMonitor = (
  stream: MediaStream,
  onSpeakingChange: (isSpeaking: boolean) => void
): SpeakingMonitorCleanup => {
  const audioTracks = stream.getAudioTracks();
  if (audioTracks.length === 0 || typeof window === 'undefined') {
    onSpeakingChange(false);
    return () => undefined;
  }

  const AudioCtor =
    window.AudioContext ??
    (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;

  if (!AudioCtor) {
    onSpeakingChange(false);
    return () => undefined;
  }

  const context = new AudioCtor();
  const analyser = context.createAnalyser();
  analyser.fftSize = ANALYSER_FFT_SIZE;
  analyser.smoothingTimeConstant = ANALYSER_SMOOTHING;

  const source = context.createMediaStreamSource(stream);
  source.connect(analyser);

  const data = new Uint8Array(analyser.fftSize);
  let frameHandle = 0;
  let disposed = false;
  let speaking = false;
  let aboveThresholdSince = 0;
  let belowThresholdSince = performance.now();

  const step = () => {
    if (disposed) {
      return;
    }

    analyser.getByteTimeDomainData(data);

    let sum = 0;
    for (let index = 0; index < data.length; index += 1) {
      const normalized = (data[index] - 128) / 128;
      sum += normalized * normalized;
    }

    const rms = Math.sqrt(sum / data.length);
    const now = performance.now();

    if (rms > SPEAKING_THRESHOLD) {
      aboveThresholdSince = aboveThresholdSince || now;
      belowThresholdSince = 0;
      if (!speaking && now - aboveThresholdSince >= SPEAKING_ENTER_MS) {
        speaking = true;
        onSpeakingChange(true);
      }
    } else {
      belowThresholdSince = belowThresholdSince || now;
      aboveThresholdSince = 0;
      if (speaking && now - belowThresholdSince >= SPEAKING_LEAVE_MS) {
        speaking = false;
        onSpeakingChange(false);
      }
    }

    frameHandle = window.requestAnimationFrame(step);
  };

  frameHandle = window.requestAnimationFrame(step);

  return () => {
    disposed = true;
    window.cancelAnimationFrame(frameHandle);
    source.disconnect();
    analyser.disconnect();
    onSpeakingChange(false);
    void context.close().catch(() => undefined);
  };
};

export const useCallRoom = () => {
  const [callState, dispatch] = useReducer(reduceCallState, undefined, createInitialCallState);
  const [joinState, setJoinState] = useState<'idle' | 'joining' | 'joined' | 'error'>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [devices, setDevices] = useState<DeviceLists>(emptyDevices);
  const [selectedAudioInputId, setSelectedAudioInputId] = useState<string>('');
  const [selectedVideoInputId, setSelectedVideoInputId] = useState<string>('');
  const [localMediaStream, setLocalMediaStream] = useState<MediaStream | null>(null);
  const [localScreenStream, setLocalScreenStream] = useState<MediaStream | null>(null);
  const [remoteStreams, setRemoteStreams] = useState<Map<string, RemoteMediaState>>(new Map());
  const [activePanel, setActivePanel] = useState<'chat' | 'participants' | 'settings'>('chat');
  const [pendingMessage, setPendingMessage] = useState('');
  const [isConnectingMedia, setIsConnectingMedia] = useState(false);
  const socketRef = useRef<Socket | null>(null);
  const peersRef = useRef<Map<string, PeerRecord>>(new Map());
  const remoteStreamsRef = useRef<Map<string, RemoteMediaState>>(new Map());
  const localParticipantIdRef = useRef<string>('');
  const localMediaStreamRef = useRef<MediaStream | null>(null);
  const localScreenStreamRef = useRef<MediaStream | null>(null);
  const callStateRef = useRef(callState);
  const speakingMonitorsRef = useRef<Map<string, SpeakingMonitorCleanup>>(new Map());
  const speakingSourcesRef = useRef<Map<string, Record<SpeakingSource, boolean>>>(new Map());

  useEffect(() => {
    callStateRef.current = callState;
  }, [callState]);

  const localParticipant = useMemo(
    () => callState.participants.find((participant) => participant.id === localParticipantIdRef.current) ?? null,
    [callState.participants]
  );

  const selectedPinnedParticipant = useMemo(
    () =>
      callState.participants.find((participant) => participant.isPinned) ??
      callState.participants.find((participant) => participant.isScreenSharing) ??
      null,
    [callState.participants]
  );

  const updateRemoteStreams = useCallback((updater: (draft: Map<string, RemoteMediaState>) => void) => {
    const next = cloneRemoteMap(remoteStreamsRef.current);
    updater(next);
    remoteStreamsRef.current = next;
    setRemoteStreams(next);
  }, []);

  const enumerateDevices = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) {
      return;
    }

    const listed = await navigator.mediaDevices.enumerateDevices();
    const nextDevices: DeviceLists = {
      audioInputs: listed.filter((device) => device.kind === 'audioinput'),
      videoInputs: listed.filter((device) => device.kind === 'videoinput'),
      audioOutputs: listed.filter((device) => device.kind === 'audiooutput')
    };

    setDevices(nextDevices);
    setSelectedAudioInputId((current) => current || nextDevices.audioInputs[0]?.deviceId || '');
    setSelectedVideoInputId((current) => current || nextDevices.videoInputs[0]?.deviceId || '');
  }, []);

  const getOrCreateLocalMediaStream = useCallback(() => {
    const stream = ensureMediaStream(localMediaStreamRef.current);
    localMediaStreamRef.current = stream;
    setLocalMediaStream(stream);
    return stream;
  }, []);

  const sendMediaState = useCallback(() => {
    const socket = socketRef.current;
    if (!socket) {
      return;
    }

    const cameraStream = localMediaStreamRef.current;
    const screenStream = localScreenStreamRef.current;
    const cameraVideoTrack = getTrackByKind(cameraStream, 'video');
    const cameraAudioTrack = getTrackByKind(cameraStream, 'audio');
    const screenAudioTrack = getTrackByKind(screenStream, 'audio');

    socket.emit('participant:media-state', {
      isCameraOn: Boolean(cameraVideoTrack?.enabled),
      isMicOn: Boolean(cameraAudioTrack?.enabled),
      isScreenSharing: Boolean(getTrackByKind(screenStream, 'video')),
      isSharingAudio: Boolean(screenAudioTrack?.enabled),
      cameraStreamId: cameraStream?.id,
      screenStreamId: screenStream?.id
    });
  }, []);

  const ensurePeerRecord = useCallback(
    (remoteParticipantId: string) => {
      const existing = peersRef.current.get(remoteParticipantId);
      if (existing) {
        return existing;
      }

      const polite = localParticipantIdRef.current.localeCompare(remoteParticipantId) > 0;
      const pc = new RTCPeerConnection(rtcConfig);
      const peerRecord: PeerRecord = {
        pc,
        polite,
        makingOffer: false,
        ignoreOffer: false,
        isSettingRemoteAnswerPending: false,
        senders: {}
      };

      pc.onicecandidate = (event) => {
        if (!event.candidate) {
          return;
        }

        socketRef.current?.emit('signal:send', {
          targetParticipantId: remoteParticipantId,
          signal: {
            type: 'candidate',
            payload: event.candidate.toJSON()
          }
        });
      };

      pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'failed' || pc.connectionState === 'closed' || pc.connectionState === 'disconnected') {
          updateRemoteStreams((draft) => {
            draft.delete(remoteParticipantId);
          });
        }
      };

      pc.ontrack = (event) => {
        const stream = event.streams[0];
        const participant = callStateRef.current.participants.find((item) => item.id === remoteParticipantId);
        const isScreenStream = participant?.screenStreamId ? participant.screenStreamId === stream.id : false;
        const bucket: keyof RemoteMediaState = isScreenStream ? 'screenStream' : 'cameraStream';

        updateRemoteStreams((draft) => {
          const current = draft.get(remoteParticipantId) ?? {};
          current[bucket] = stream;
          draft.set(remoteParticipantId, current);
        });
      };

      pc.onnegotiationneeded = async () => {
        try {
          peerRecord.makingOffer = true;
          await syncPeerTracks(remoteParticipantId);
          await pc.setLocalDescription();

          if (pc.localDescription) {
            socketRef.current?.emit('signal:send', {
              targetParticipantId: remoteParticipantId,
              signal: {
                type: pc.localDescription.type as 'offer' | 'answer',
                payload: pc.localDescription.toJSON()
              }
            });
          }
        } catch (error) {
          console.error('Negotiation failed', error);
        } finally {
          peerRecord.makingOffer = false;
        }
      };

      peersRef.current.set(remoteParticipantId, peerRecord);
      return peerRecord;
    },
    [updateRemoteStreams]
  );

  const syncPeerTracks = useCallback(
    async (remoteParticipantId: string) => {
      const peer = ensurePeerRecord(remoteParticipantId);
      const cameraStream = localMediaStreamRef.current;
      const screenStream = localScreenStreamRef.current;
      const cameraVideoTrack = getTrackByKind(cameraStream, 'video');
      const cameraAudioTrack = getTrackByKind(cameraStream, 'audio');
      const screenVideoTrack = getTrackByKind(screenStream, 'video');
      const screenAudioTrack = getTrackByKind(screenStream, 'audio');

      const syncTrack = (
        senderKey: keyof PeerRecord['senders'],
        track: MediaStreamTrack | null,
        stream: MediaStream | null
      ) => {
        const currentSender = peer.senders[senderKey];
        if (track && currentSender) {
          void currentSender.replaceTrack(track);
          return;
        }

        if (track && !currentSender && stream) {
          peer.senders[senderKey] = peer.pc.addTrack(track, stream);
          return;
        }

        if (!track && currentSender) {
          peer.pc.removeTrack(currentSender);
          peer.senders[senderKey] = undefined;
        }
      };

      syncTrack('cameraVideo', cameraVideoTrack, cameraStream);
      syncTrack('cameraAudio', cameraAudioTrack, cameraStream);
      syncTrack('screenVideo', screenVideoTrack, screenStream);
      syncTrack('screenAudio', screenAudioTrack, screenStream);
    },
    [ensurePeerRecord]
  );

  const syncAllPeerTracks = useCallback(async () => {
    const remoteParticipants = callStateRef.current.participants.filter(
      (participant) => participant.id !== localParticipantIdRef.current
    );

    for (const participant of remoteParticipants) {
      await syncPeerTracks(participant.id);
    }
  }, [syncPeerTracks]);

  const closeAllPeers = useCallback(() => {
    peersRef.current.forEach((peer) => peer.pc.close());
    peersRef.current.clear();
    remoteStreamsRef.current = new Map();
    setRemoteStreams(new Map());
  }, []);

  const stopAllTracks = useCallback((stream: MediaStream | null) => {
    stream?.getTracks().forEach((track) => track.stop());
  }, []);

  const updateSpeakingState = useCallback((participantId: string, source: SpeakingSource, isSpeaking: boolean) => {
    const current = speakingSourcesRef.current.get(participantId) ?? { camera: false, screen: false };
    current[source] = isSpeaking;
    speakingSourcesRef.current.set(participantId, current);

    dispatch({
      type: 'participants/speakingChanged',
      participantId,
      isSpeaking: current.camera || current.screen
    });
  }, []);

  useEffect(() => {
    const desiredMonitors = new Map<string, { participantId: string; source: SpeakingSource; stream: MediaStream }>();
    const localStream = localMediaStreamRef.current;

    if (localStream && getTrackByKind(localStream, 'audio')) {
      desiredMonitors.set(`local:${localParticipantIdRef.current}:camera`, {
        participantId: localParticipantIdRef.current,
        source: 'camera',
        stream: localStream
      });
    }

    remoteStreams.forEach((mediaState, participantId) => {
      if (mediaState.cameraStream && getTrackByKind(mediaState.cameraStream, 'audio')) {
        desiredMonitors.set(`${participantId}:camera`, {
          participantId,
          source: 'camera',
          stream: mediaState.cameraStream
        });
      }

      if (mediaState.screenStream && getTrackByKind(mediaState.screenStream, 'audio')) {
        desiredMonitors.set(`${participantId}:screen`, {
          participantId,
          source: 'screen',
          stream: mediaState.screenStream
        });
      }
    });

    speakingMonitorsRef.current.forEach((cleanup, key) => {
      const desired = desiredMonitors.get(key);
      const currentStream = desired?.stream;
      const currentRegistered = (cleanup as SpeakingMonitorCleanup & { stream?: MediaStream }).stream;

      if (!desired || currentRegistered !== currentStream) {
        cleanup();
        speakingMonitorsRef.current.delete(key);
      }
    });

    desiredMonitors.forEach(({ participantId, source, stream }, key) => {
      if (speakingMonitorsRef.current.has(key)) {
        return;
      }

      const cleanup = createSpeakingMonitor(stream, (isSpeaking) => {
        if (participantId) {
          updateSpeakingState(participantId, source, isSpeaking);
        }
      }) as SpeakingMonitorCleanup & { stream?: MediaStream };
      cleanup.stream = stream;
      speakingMonitorsRef.current.set(key, cleanup);
    });

    return () => undefined;
  }, [localMediaStream, remoteStreams, updateSpeakingState]);

  const replaceLocalTrack = useCallback(
    async (kind: 'audio' | 'video', track: MediaStreamTrack) => {
      const stream = replaceTrackInStream(localMediaStreamRef.current, kind, track);
      localMediaStreamRef.current = stream;
      setLocalMediaStream(stream);
      await syncAllPeerTracks();
      sendMediaState();
      setErrorMessage(null);
    },
    [sendMediaState, syncAllPeerTracks]
  );

  const requestTrack = useCallback(
    async (kind: 'audio' | 'video', deviceId?: string, enabled = true) => {
      setIsConnectingMedia(true);
      try {
        const constraints =
          kind === 'audio'
            ? { audio: deviceId ? { deviceId: { exact: deviceId } } : true, video: false }
            : { audio: false, video: deviceId ? { deviceId: { exact: deviceId } } : true };

        const requested = await navigator.mediaDevices.getUserMedia(constraints);
        const track = getTrackByKind(requested, kind);

        if (!track) {
          throw new Error(`No ${kind} track returned by getUserMedia`);
        }

        track.enabled = enabled;
        await replaceLocalTrack(kind, track);
        await enumerateDevices();
      } catch (error) {
        console.error(error);
        setErrorMessage(
          kind === 'audio'
            ? 'Не удалось включить микрофон. Проверь доступ браузера к устройству.'
            : 'Не удалось включить камеру. Проверь доступ браузера к устройству.'
        );
      } finally {
        setIsConnectingMedia(false);
      }
    },
    [enumerateDevices, replaceLocalTrack]
  );

  const ensureAudioTrack = useCallback(async () => {
    await requestTrack('audio', selectedAudioInputId || undefined, true);
  }, [requestTrack, selectedAudioInputId]);

  const ensureVideoTrack = useCallback(async () => {
    await requestTrack('video', selectedVideoInputId || undefined, true);
  }, [requestTrack, selectedVideoInputId]);

  const setAudioEnabled = useCallback(
    async (enabled: boolean) => {
      const track = setTrackEnabled(localMediaStreamRef.current, 'audio', enabled);
      if (!track) {
        if (enabled) {
          await ensureAudioTrack();
        }
        return;
      }

      sendMediaState();
    },
    [ensureAudioTrack, sendMediaState]
  );

  const setVideoEnabled = useCallback(
    async (enabled: boolean) => {
      const track = setTrackEnabled(localMediaStreamRef.current, 'video', enabled);
      if (!track) {
        if (enabled) {
          await ensureVideoTrack();
        }
        return;
      }

      sendMediaState();
    },
    [ensureVideoTrack, sendMediaState]
  );

  const stopAudioTrack = useCallback(async () => {
    await setAudioEnabled(false);
  }, [setAudioEnabled]);

  const stopVideoTrack = useCallback(async () => {
    await setVideoEnabled(false);
  }, [setVideoEnabled]);

  const handleSignal = useCallback(
    async (fromParticipantId: string, signal: SignalPayload) => {
      const peer = ensurePeerRecord(fromParticipantId);
      const readyForOffer =
        !peer.makingOffer && (peer.pc.signalingState === 'stable' || peer.isSettingRemoteAnswerPending);

      if (signal.type === 'candidate') {
        try {
          await peer.pc.addIceCandidate(signal.payload);
        } catch (error) {
          if (!peer.ignoreOffer) {
            console.error('Failed to apply ICE candidate', error);
          }
        }
        return;
      }

      const description = signal.payload;
      const offerCollision = description.type === 'offer' && !readyForOffer;
      peer.ignoreOffer = !peer.polite && offerCollision;
      if (peer.ignoreOffer) {
        return;
      }

      peer.isSettingRemoteAnswerPending = description.type === 'answer';
      await peer.pc.setRemoteDescription(description);
      peer.isSettingRemoteAnswerPending = false;

      if (description.type === 'offer') {
        await syncPeerTracks(fromParticipantId);
        await peer.pc.setLocalDescription();
        if (peer.pc.localDescription) {
          socketRef.current?.emit('signal:send', {
            targetParticipantId: fromParticipantId,
            signal: {
              type: 'answer',
              payload: peer.pc.localDescription.toJSON()
            }
          });
        }
      }
    },
    [ensurePeerRecord, syncPeerTracks]
  );

  const teardown = useCallback(() => {
    socketRef.current?.disconnect();
    socketRef.current = null;
    closeAllPeers();
    speakingMonitorsRef.current.forEach((cleanup) => cleanup());
    speakingMonitorsRef.current.clear();
    speakingSourcesRef.current.clear();
    stopAllTracks(localMediaStreamRef.current);
    stopAllTracks(localScreenStreamRef.current);
    localMediaStreamRef.current = null;
    localScreenStreamRef.current = null;
    setLocalMediaStream(null);
    setLocalScreenStream(null);
  }, [closeAllPeers, stopAllTracks]);

  const leaveRoom = useCallback(() => {
    teardown();
    localParticipantIdRef.current = '';
    dispatch({ type: 'session/reset' });
    setJoinState('idle');
  }, [teardown]);

  const joinRoom = useCallback(
    async ({ roomId, displayName }: JoinForm) => {
      setJoinState('joining');
      setErrorMessage(null);
      dispatch({ type: 'session/reset' });

      const socket = io(serverUrl, {
        transports: ['websocket']
      });

      socketRef.current = socket;

      socket.on('participant:joined', async ({ participant, message }: { participant: WireParticipant; message: ChatMessage }) => {
        dispatch({ type: 'participants/upserted', participant });
        dispatch({ type: 'chat/messageReceived', message });

        if (participant.id !== localParticipantIdRef.current) {
          ensurePeerRecord(participant.id);
          await syncPeerTracks(participant.id);
        }
      });

      socket.on('participant:updated', ({ participant }: { participant: WireParticipant }) => {
        dispatch({ type: 'participants/upserted', participant });
        updateRemoteStreams((draft) => {
          const current = draft.get(participant.id);
          if (!current) {
            return;
          }

          if (participant.screenStreamId && current.cameraStream?.id === participant.screenStreamId) {
            current.screenStream = current.cameraStream;
            current.cameraStream = undefined;
          }

          draft.set(participant.id, current);
        });
      });

      socket.on(
        'participant:left',
        ({ participantId, participants, message }: { participantId: string; participants: WireParticipant[]; message: ChatMessage }) => {
          peersRef.current.get(participantId)?.pc.close();
          peersRef.current.delete(participantId);
          updateRemoteStreams((draft) => {
            draft.delete(participantId);
          });
          dispatch({ type: 'participants/synced', participants });
          dispatch({ type: 'chat/messageReceived', message });
        }
      );

      socket.on('chat:received', ({ message }: { message: ChatMessage }) => {
        dispatch({ type: 'chat/messageReceived', message });
      });

      socket.on('chat:error', ({ message }: { message: string }) => {
        setErrorMessage(message);
      });

      socket.on('room:policy-updated', ({ policy }: { policy: RoomPolicy }) => {
        dispatch({ type: 'room/policySynced', policy });
      });

      socket.on(
        'signal:received',
        async ({ fromParticipantId, signal }: { fromParticipantId: string; signal: SignalPayload }) => {
          try {
            await handleSignal(fromParticipantId, signal);
          } catch (error) {
            console.error('Signal handling failed', error);
          }
        }
      );

      socket.on('disconnect', () => {
        setJoinState('idle');
      });

      socket.emit('room:join', { roomId, displayName }, async (response: JoinAck) => {
        if (!response.ok) {
          setJoinState('error');
          setErrorMessage(response.error);
          socket.disconnect();
          return;
        }

        localParticipantIdRef.current = response.participantId;
        dispatch({ type: 'participants/synced', participants: response.participants });
        dispatch({ type: 'room/policySynced', policy: response.policy });
        response.chatMessages.forEach((message) => {
          dispatch({ type: 'chat/messageReceived', message });
        });

        await enumerateDevices();
        sendMediaState();
        setJoinState('joined');
      });
    },
    [ensurePeerRecord, enumerateDevices, handleSignal, sendMediaState, syncPeerTracks, updateRemoteStreams]
  );

  const stopScreenShare = useCallback(async () => {
    const previous = localScreenStreamRef.current;
    localScreenStreamRef.current = null;
    setLocalScreenStream(null);
    stopAllTracks(previous);
    await syncAllPeerTracks();
    sendMediaState();
  }, [sendMediaState, stopAllTracks, syncAllPeerTracks]);

  const startScreenShare = useCallback(async () => {
    try {
      const canShareAudio = callStateRef.current.policy.allowSystemAudio;
      const displayStream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          frameRate: 15
        },
        audio: canShareAudio
      });

      displayStream.getVideoTracks()[0]?.addEventListener('ended', () => {
        void stopScreenShare();
      });

      const previous = localScreenStreamRef.current;
      localScreenStreamRef.current = displayStream;
      setLocalScreenStream(displayStream);
      stopAllTracks(previous);

      await syncAllPeerTracks();
      sendMediaState();
    } catch (error) {
      console.error(error);
      setErrorMessage('Не удалось запустить демонстрацию экрана.');
    }
  }, [sendMediaState, stopAllTracks, stopScreenShare, syncAllPeerTracks]);

  const sendChatMessage = useCallback(() => {
    const text = pendingMessage.trim();
    if (!text) {
      return;
    }

    socketRef.current?.emit('chat:send', { text });
    setPendingMessage('');
  }, [pendingMessage]);

  const updatePolicy = useCallback((patch: Partial<RoomPolicy>) => {
    socketRef.current?.emit('room:policy', patch);
  }, []);

  const pinParticipant = useCallback((participantId: string | null) => {
    dispatch({ type: 'participants/pinned', participantId });
  }, []);

  useEffect(() => {
    void enumerateDevices();
    navigator.mediaDevices?.addEventListener?.('devicechange', enumerateDevices);
    return () => {
      navigator.mediaDevices?.removeEventListener?.('devicechange', enumerateDevices);
      teardown();
    };
  }, [enumerateDevices, teardown]);

  const applyAudioInput = useCallback(
    async (deviceId: string) => {
      setSelectedAudioInputId(deviceId);
      const existing = getTrackByKind(localMediaStreamRef.current, 'audio');
      if (!existing) {
        return;
      }

      await requestTrack('audio', deviceId, existing.enabled);
    },
    [requestTrack]
  );

  const applyVideoInput = useCallback(
    async (deviceId: string) => {
      setSelectedVideoInputId(deviceId);
      const existing = getTrackByKind(localMediaStreamRef.current, 'video');
      if (!existing) {
        return;
      }

      await requestTrack('video', deviceId, existing.enabled);
    },
    [requestTrack]
  );

  const toggleMicrophone = useCallback(async () => {
    const audioTrack = getTrackByKind(localMediaStreamRef.current, 'audio');
    if (!audioTrack) {
      await ensureAudioTrack();
      return;
    }

    await (audioTrack.enabled ? stopAudioTrack() : setAudioEnabled(true));
  }, [ensureAudioTrack, setAudioEnabled, stopAudioTrack]);

  const toggleCamera = useCallback(async () => {
    const videoTrack = getTrackByKind(localMediaStreamRef.current, 'video');
    if (!videoTrack) {
      await ensureVideoTrack();
      return;
    }

    await (videoTrack.enabled ? stopVideoTrack() : setVideoEnabled(true));
  }, [ensureVideoTrack, setVideoEnabled, stopVideoTrack]);

  return {
    joinState,
    errorMessage,
    callState,
    localParticipant,
    localParticipantId: localParticipantIdRef.current,
    localCameraStream: localMediaStream,
    localScreenStream,
    remoteStreams,
    devices,
    selectedAudioInputId,
    selectedVideoInputId,
    pendingMessage,
    activePanel,
    isConnectingMedia,
    selectedPinnedParticipant,
    setPendingMessage,
    setActivePanel,
    joinRoom,
    leaveRoom,
    toggleMicrophone,
    toggleCamera,
    startScreenShare,
    stopScreenShare,
    sendChatMessage,
    updatePolicy,
    pinParticipant,
    applyAudioInput,
    applyVideoInput
  };
};
