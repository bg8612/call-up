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
  clientSessionId: string;
};

type JoinAck =
  | {
      ok: true;
      participantId: string;
      clientSessionId: string;
      roomId: string;
      participants: WireParticipant[];
      chatMessages: ChatMessage[];
      policy: RoomPolicy;
    }
  | { ok: false; error: string };

type MediaStateAck =
  | {
      ok: true;
      participant: WireParticipant;
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
  pendingIceCandidates: RTCIceCandidateInit[];
  senders: {
    cameraVideo?: RTCRtpSender;
    cameraAudio?: RTCRtpSender;
    screenVideo?: RTCRtpSender;
    screenAudio?: RTCRtpSender;
  };
};

type SpeakingMonitorCleanup = () => void;
type SpeakingSource = 'camera' | 'screen';

const emptyDevices: DeviceLists = {
  audioInputs: [],
  videoInputs: [],
  audioOutputs: []
};

const defaultStunServers = ['stun:stun.l.google.com:19302'];

const parseIceServerUrls = (value?: string) =>
  value
    ?.split(',')
    .map((item) => item.trim())
    .filter(Boolean) ?? [];

const createRtcConfig = (): RTCConfiguration => {
  const iceServers: RTCIceServer[] = [];
  const stunUrls = parseIceServerUrls(import.meta.env.VITE_STUN_URLS);
  const turnUrls = parseIceServerUrls(import.meta.env.VITE_TURN_URLS);
  const turnUsername = import.meta.env.VITE_TURN_USERNAME;
  const turnCredential = import.meta.env.VITE_TURN_CREDENTIAL;

  iceServers.push({
    urls: stunUrls.length ? stunUrls : defaultStunServers
  });

  if (turnUrls.length && turnUsername && turnCredential) {
    iceServers.push({
      urls: turnUrls,
      username: turnUsername,
      credential: turnCredential
    });
  }

  return { iceServers };
};

const rtcConfig = createRtcConfig();

const isLocalHostname = (hostname: string) =>
  hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';

const canUseLocalPreviewFallback = () => {
  if (typeof window === 'undefined') {
    return true;
  }

  return isLocalHostname(window.location.hostname);
};

const resolveServerUrl = () => {
  if (import.meta.env.VITE_SERVER_URL) {
    return import.meta.env.VITE_SERVER_URL;
  }

  if (typeof window === 'undefined') {
    return 'http://localhost:3001';
  }

  if (window.location.port === '3001') {
    return window.location.origin;
  }

  if (isLocalHostname(window.location.hostname) || window.location.port === '5173') {
    return `${window.location.protocol}//${window.location.hostname}:3001`;
  }

  return window.location.origin;
};

const serverUrl = resolveServerUrl();

const SPEAKING_THRESHOLD = 0.045;
const SPEAKING_ENTER_MS = 45;
const SPEAKING_LEAVE_MS = 180;
const ANALYSER_FFT_SIZE = 512;
const ANALYSER_SMOOTHING = 0.62;
const JOIN_ACK_TIMEOUT_MS = 8_000;
const CAMERA_MAX_BITRATE = 1_500_000;
const PEER_RECOVERY_DELAY_MS = 1_500;
const MEDIA_RECOVERY_GRACE_MS = 3_500;
const SPEAKING_SYNC_MIN_INTERVAL_MS = 250;

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
  const [selectedAudioOutputId, setSelectedAudioOutputId] = useState<string>('');
  const [selectedVideoInputId, setSelectedVideoInputId] = useState<string>('');
  const [localMediaStream, setLocalMediaStream] = useState<MediaStream | null>(null);
  const [localScreenStream, setLocalScreenStream] = useState<MediaStream | null>(null);
  const [remoteStreams, setRemoteStreams] = useState<Map<string, RemoteMediaState>>(new Map());
  const [activePanel, setActivePanel] = useState<'chat' | 'participants' | 'settings'>('chat');
  const [pendingMessage, setPendingMessage] = useState('');
  const [isConnectingMedia, setIsConnectingMedia] = useState(false);
  const socketRef = useRef<Socket | null>(null);
  const peersRef = useRef<Map<string, PeerRecord>>(new Map());
  const peerRecoveryTimersRef = useRef<Map<string, number>>(new Map());
  const mediaRecoveryTimersRef = useRef<Map<string, number>>(new Map());
  const remoteStreamsRef = useRef<Map<string, RemoteMediaState>>(new Map());
  const localParticipantIdRef = useRef<string>('');
  const localMediaStreamRef = useRef<MediaStream | null>(null);
  const localScreenStreamRef = useRef<MediaStream | null>(null);
  const callStateRef = useRef(callState);
  const speakingMonitorsRef = useRef<Map<string, SpeakingMonitorCleanup>>(new Map());
  const speakingSourcesRef = useRef<Record<SpeakingSource, boolean>>({ camera: false, screen: false });
  const speakingSyncRef = useRef<{ value: boolean; sentAt: number }>({ value: false, sentAt: 0 });
  const localPreviewModeRef = useRef(false);
  const activeJoinSessionRef = useRef<JoinForm | null>(null);
  const joinAckTimerRef = useRef<number | null>(null);
  const hasJoinedRoomRef = useRef(false);
  const negotiatePeerConnectionRef = useRef<(participantId: string, iceRestart?: boolean) => Promise<void>>(
    async () => undefined
  );
  const recoverPeerConnectionRef = useRef<(participantId: string, iceRestart?: boolean) => Promise<void>>(
    async () => undefined
  );

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

  const clearJoinAckTimer = useCallback(() => {
    if (joinAckTimerRef.current === null) {
      return;
    }

    window.clearTimeout(joinAckTimerRef.current);
    joinAckTimerRef.current = null;
  }, []);

  const updateParticipantConnectionState = useCallback((participantId: string, connectionState: Participant['connectionState']) => {
    const participant = callStateRef.current.participants.find((item) => item.id === participantId);
    if (!participant) {
      return;
    }

    dispatch({
      type: 'participants/upserted',
      participant: {
        ...participant,
        connectionState
      }
    });
  }, []);

  const clearPeerRecovery = useCallback((participantId: string) => {
    const timer = peerRecoveryTimersRef.current.get(participantId);
    if (timer === undefined) {
      return;
    }

    window.clearTimeout(timer);
    peerRecoveryTimersRef.current.delete(participantId);
  }, []);

  const clearMediaRecovery = useCallback((participantId: string) => {
    const timer = mediaRecoveryTimersRef.current.get(participantId);
    if (timer === undefined) {
      return;
    }

    window.clearTimeout(timer);
    mediaRecoveryTimersRef.current.delete(participantId);
  }, []);

  const hasExpectedRemoteMedia = useCallback((participantId: string, participant: Participant) => {
    const media = remoteStreamsRef.current.get(participantId);
    const hasCameraTrack = Boolean(getTrackByKind(media?.cameraStream ?? null, 'video'));
    const hasMicTrack = Boolean(getTrackByKind(media?.cameraStream ?? null, 'audio'));
    const hasScreenTrack = Boolean(getTrackByKind(media?.screenStream ?? null, 'video'));
    const hasScreenAudio = Boolean(getTrackByKind(media?.screenStream ?? null, 'audio'));

    const cameraSatisfied = !participant.isCameraOn || hasCameraTrack;
    const micSatisfied = !participant.isMicOn || hasMicTrack;
    const screenSatisfied = !participant.isScreenSharing || hasScreenTrack;
    const screenAudioSatisfied = !participant.isSharingAudio || hasScreenAudio;
    return cameraSatisfied && micSatisfied && screenSatisfied && screenAudioSatisfied;
  }, []);

  const ensureRemoteMediaRecovery = useCallback(
    (participant: Participant) => {
      if (
        participant.id === localParticipantIdRef.current ||
        participant.connectionState !== 'connected'
      ) {
        clearMediaRecovery(participant.id);
        return;
      }

      const expectsAnyMedia = participant.isCameraOn || participant.isMicOn || participant.isScreenSharing || participant.isSharingAudio;
      if (!expectsAnyMedia || hasExpectedRemoteMedia(participant.id, participant)) {
        clearMediaRecovery(participant.id);
        return;
      }

      if (mediaRecoveryTimersRef.current.has(participant.id)) {
        return;
      }

      const timer = window.setTimeout(() => {
        mediaRecoveryTimersRef.current.delete(participant.id);
        void recoverPeerConnectionRef.current(participant.id, true);
      }, MEDIA_RECOVERY_GRACE_MS);

      mediaRecoveryTimersRef.current.set(participant.id, timer);
    },
    [clearMediaRecovery, hasExpectedRemoteMedia]
  );

  const schedulePeerRecovery = useCallback(
    (participantId: string, iceRestart = false) => {
      if (peerRecoveryTimersRef.current.has(participantId)) {
        return;
      }

      const timer = window.setTimeout(() => {
        peerRecoveryTimersRef.current.delete(participantId);
        void recoverPeerConnectionRef.current(participantId, iceRestart);
      }, PEER_RECOVERY_DELAY_MS);

      peerRecoveryTimersRef.current.set(participantId, timer);
    },
    []
  );

  const configureSenderParameters = useCallback(
    async (sender: RTCRtpSender | undefined, senderKey: keyof PeerRecord['senders']) => {
      if (!sender || senderKey !== 'cameraVideo' || typeof sender.getParameters !== 'function') {
        return;
      }

      const parameters = sender.getParameters();
      parameters.degradationPreference = 'balanced';
      parameters.encodings = parameters.encodings?.length ? parameters.encodings : [{}];
      parameters.encodings[0] = {
        ...parameters.encodings[0],
        maxBitrate: CAMERA_MAX_BITRATE
      };

      try {
        await sender.setParameters(parameters);
      } catch (error) {
        console.warn('Failed to configure camera sender parameters', error);
      }
    },
    []
  );

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
    setSelectedAudioOutputId((current) => current || nextDevices.audioOutputs[0]?.deviceId || '');
    setSelectedVideoInputId((current) => current || nextDevices.videoInputs[0]?.deviceId || '');
  }, []);

  const getOrCreateLocalMediaStream = useCallback(() => {
    const stream = ensureMediaStream(localMediaStreamRef.current);
    localMediaStreamRef.current = stream;
    setLocalMediaStream(stream);
    return stream;
  }, []);

  const sendMediaState = useCallback(async () => {
    const socket = socketRef.current;
    const cameraStream = localMediaStreamRef.current;
    const screenStream = localScreenStreamRef.current;
    const cameraVideoTrack = getTrackByKind(cameraStream, 'video');
    const cameraAudioTrack = getTrackByKind(cameraStream, 'audio');
    const screenAudioTrack = getTrackByKind(screenStream, 'audio');
    const mediaState = {
      isCameraOn: Boolean(cameraVideoTrack?.enabled),
      isMicOn: Boolean(cameraAudioTrack?.enabled),
      isScreenSharing: Boolean(getTrackByKind(screenStream, 'video')),
      isSharingAudio: Boolean(screenAudioTrack?.enabled),
      cameraStreamId: cameraStream?.id,
      screenStreamId: screenStream?.id
    };

    if (localParticipantIdRef.current) {
      const existing = callStateRef.current.participants.find(
        (participant) => participant.id === localParticipantIdRef.current
      );

      if (existing) {
        dispatch({
          type: 'participants/upserted',
          participant: {
            ...existing,
            ...mediaState
          }
        });
      }
    }

    if (!socket) {
      return;
    }

    await new Promise<void>((resolve) => {
      socket.emit('participant:media-state', mediaState, (response: MediaStateAck) => {
        if (response?.ok) {
          dispatch({
            type: 'participants/upserted',
            participant: response.participant
          });
          setErrorMessage(null);
        } else if (response?.error) {
          setErrorMessage(response.error);
        }

        resolve();
      });
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
        pendingIceCandidates: [],
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
        if (pc.connectionState === 'connected') {
          clearPeerRecovery(remoteParticipantId);
          return;
        }

        if (pc.connectionState === 'disconnected') {
          schedulePeerRecovery(remoteParticipantId, true);
          return;
        }

        if (pc.connectionState === 'failed') {
          schedulePeerRecovery(remoteParticipantId, true);
          return;
        }

        if (pc.connectionState === 'closed') {
          clearPeerRecovery(remoteParticipantId);
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

        const currentParticipant = callStateRef.current.participants.find((item) => item.id === remoteParticipantId);
        if (currentParticipant) {
          ensureRemoteMediaRecovery(currentParticipant);
        }
      };

      pc.onnegotiationneeded = async () => {
        await negotiatePeerConnectionRef.current(remoteParticipantId);
      };

      peersRef.current.set(remoteParticipantId, peerRecord);
      return peerRecord;
    },
    [clearPeerRecovery, ensureRemoteMediaRecovery, schedulePeerRecovery, updateRemoteStreams]
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

      const syncTrack = async (
        senderKey: keyof PeerRecord['senders'],
        track: MediaStreamTrack | null,
        stream: MediaStream | null
      ) => {
        const currentSender = peer.senders[senderKey];
        if (track && currentSender) {
          await currentSender.replaceTrack(track);
          await configureSenderParameters(currentSender, senderKey);
          return;
        }

        if (track && !currentSender && stream) {
          peer.senders[senderKey] = peer.pc.addTrack(track, stream);
          await configureSenderParameters(peer.senders[senderKey], senderKey);
          return;
        }

        if (!track && currentSender) {
          peer.pc.removeTrack(currentSender);
          peer.senders[senderKey] = undefined;
        }
      };

      await syncTrack('cameraVideo', cameraVideoTrack, cameraStream);
      await syncTrack('cameraAudio', cameraAudioTrack, cameraStream);
      await syncTrack('screenVideo', screenVideoTrack, screenStream);
      await syncTrack('screenAudio', screenAudioTrack, screenStream);
    },
    [configureSenderParameters, ensurePeerRecord]
  );

  const syncAllPeerTracks = useCallback(async () => {
    const remoteParticipants = callStateRef.current.participants.filter(
      (participant) => participant.id !== localParticipantIdRef.current
    );

    for (const participant of remoteParticipants) {
      await syncPeerTracks(participant.id);
    }
  }, [syncPeerTracks]);

  const negotiatePeerConnection = useCallback(
    async (remoteParticipantId: string, iceRestart = false) => {
      const peer = ensurePeerRecord(remoteParticipantId);
      if (peer.makingOffer || peer.pc.signalingState !== 'stable') {
        return;
      }

      try {
        peer.makingOffer = true;
        await syncPeerTracks(remoteParticipantId);
        const offer = await peer.pc.createOffer(iceRestart ? { iceRestart: true } : undefined);
        await peer.pc.setLocalDescription(offer);

        if (peer.pc.localDescription) {
          socketRef.current?.emit('signal:send', {
            targetParticipantId: remoteParticipantId,
            signal: {
              type: 'offer',
              payload: peer.pc.localDescription.toJSON()
            }
          });
        }
      } catch (error) {
        console.error('Negotiation failed', error);
      } finally {
        peer.makingOffer = false;
      }
    },
    [ensurePeerRecord, syncPeerTracks]
  );

  negotiatePeerConnectionRef.current = negotiatePeerConnection;

  const recoverPeerConnection = useCallback(
    async (remoteParticipantId: string, iceRestart = false) => {
      const remoteParticipant = callStateRef.current.participants.find((participant) => participant.id === remoteParticipantId);
      if (!remoteParticipant || remoteParticipant.id === localParticipantIdRef.current) {
        return;
      }

      const existing = peersRef.current.get(remoteParticipantId);
      if (existing?.pc.connectionState === 'connected') {
        clearPeerRecovery(remoteParticipantId);
        return;
      }

      if (iceRestart && existing && existing.pc.signalingState === 'stable') {
        await negotiatePeerConnection(remoteParticipantId, true);
        return;
      }

      existing?.pc.close();
      peersRef.current.delete(remoteParticipantId);
      clearPeerRecovery(remoteParticipantId);
      ensurePeerRecord(remoteParticipantId);
      await negotiatePeerConnection(remoteParticipantId, false);
    },
    [clearPeerRecovery, ensurePeerRecord, negotiatePeerConnection]
  );

  recoverPeerConnectionRef.current = recoverPeerConnection;

  const closeAllPeers = useCallback(() => {
    peersRef.current.forEach((peer) => peer.pc.close());
    peersRef.current.clear();
    peerRecoveryTimersRef.current.forEach((timer) => window.clearTimeout(timer));
    peerRecoveryTimersRef.current.clear();
    mediaRecoveryTimersRef.current.forEach((timer) => window.clearTimeout(timer));
    mediaRecoveryTimersRef.current.clear();
    remoteStreamsRef.current = new Map();
    setRemoteStreams(new Map());
  }, []);

  const stopAllTracks = useCallback((stream: MediaStream | null) => {
    stream?.getTracks().forEach((track) => track.stop());
  }, []);

  const emitSpeakingState = useCallback((isSpeaking: boolean) => {
    if (localPreviewModeRef.current) {
      return;
    }

    const socket = socketRef.current;
    if (!socket || !localParticipantIdRef.current) {
      return;
    }

    const now = Date.now();
    const shouldSkip =
      speakingSyncRef.current.value === isSpeaking &&
      now - speakingSyncRef.current.sentAt < SPEAKING_SYNC_MIN_INTERVAL_MS;
    if (shouldSkip) {
      return;
    }

    speakingSyncRef.current = {
      value: isSpeaking,
      sentAt: now
    };

    socket.emit('participant:speaking-state', { isSpeaking });
  }, []);

  const updateLocalSpeakingSource = useCallback(
    (source: SpeakingSource, isSpeaking: boolean) => {
      speakingSourcesRef.current[source] = isSpeaking;
      const aggregatedSpeaking = speakingSourcesRef.current.camera || speakingSourcesRef.current.screen;
      const localParticipantId = localParticipantIdRef.current;
      if (!localParticipantId) {
        return;
      }

      dispatch({
        type: 'participants/speakingChanged',
        participantId: localParticipantId,
        isSpeaking: aggregatedSpeaking
      });

      emitSpeakingState(aggregatedSpeaking);
    },
    [emitSpeakingState]
  );

  useEffect(() => {
    const desiredMonitors = new Map<string, { source: SpeakingSource; stream: MediaStream }>();
    const localStream = localMediaStreamRef.current;
    const localScreen = localScreenStreamRef.current;
    const localParticipantId = localParticipantIdRef.current;

    if (localParticipantId && localStream && getTrackByKind(localStream, 'audio')) {
      desiredMonitors.set('local:camera', {
        source: 'camera',
        stream: localStream
      });
    }

    if (localParticipantId && localScreen && getTrackByKind(localScreen, 'audio')) {
      desiredMonitors.set('local:screen', {
        source: 'screen',
        stream: localScreen
      });
    }

    speakingMonitorsRef.current.forEach((cleanup, key) => {
      const desired = desiredMonitors.get(key);
      const currentStream = desired?.stream;
      const currentRegistered = (cleanup as SpeakingMonitorCleanup & { stream?: MediaStream }).stream;

      if (!desired || currentRegistered !== currentStream) {
        cleanup();
        speakingMonitorsRef.current.delete(key);
      }
    });

    desiredMonitors.forEach(({ source, stream }, key) => {
      if (speakingMonitorsRef.current.has(key)) {
        return;
      }

      const cleanup = createSpeakingMonitor(stream, (isSpeaking) => {
        updateLocalSpeakingSource(source, isSpeaking);
      }) as SpeakingMonitorCleanup & { stream?: MediaStream };
      cleanup.stream = stream;
      speakingMonitorsRef.current.set(key, cleanup);
    });

    return () => undefined;
  }, [localMediaStream, localScreenStream, updateLocalSpeakingSource]);

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
            : {
                audio: false,
                video: {
                  deviceId: deviceId ? { exact: deviceId } : undefined,
                  width: { ideal: 1280 },
                  height: { ideal: 720 },
                  frameRate: { ideal: 24, max: 30 }
                }
              };

        const requested = await navigator.mediaDevices.getUserMedia(constraints);
        const track = getTrackByKind(requested, kind);

        if (!track) {
          throw new Error(`No ${kind} track returned by getUserMedia`);
        }

        if (kind === 'video') {
          track.contentHint = 'motion';
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

      const flushPendingIceCandidates = async () => {
        if (peer.pendingIceCandidates.length === 0) {
          return;
        }

        const queuedCandidates = [...peer.pendingIceCandidates];
        peer.pendingIceCandidates = [];

        for (const queuedCandidate of queuedCandidates) {
          try {
            await peer.pc.addIceCandidate(queuedCandidate);
          } catch (error) {
            console.error('Failed to apply queued ICE candidate', error);
          }
        }
      };

      if (signal.type === 'candidate') {
        const hasRemoteDescription = Boolean(
          peer.pc.remoteDescription ?? peer.pc.currentRemoteDescription ?? peer.pc.pendingRemoteDescription
        );
        if (!hasRemoteDescription) {
          peer.pendingIceCandidates.push(signal.payload);
          return;
        }

        try {
          await peer.pc.addIceCandidate(signal.payload);
        } catch (error) {
          if (!peer.ignoreOffer) {
            console.error('Failed to apply ICE candidate', error);
          }
        }
        return;
      }

      const description = {
        ...signal.payload,
        type: signal.payload.type ?? signal.type
      } satisfies RTCSessionDescriptionInit;
      const offerCollision = description.type === 'offer' && !readyForOffer;
      peer.ignoreOffer = !peer.polite && offerCollision;
      if (peer.ignoreOffer) {
        return;
      }

      if (offerCollision) {
        await peer.pc.setLocalDescription({ type: 'rollback' });
      }

      peer.isSettingRemoteAnswerPending = description.type === 'answer';
      await peer.pc.setRemoteDescription(description);
      peer.isSettingRemoteAnswerPending = false;
      await flushPendingIceCandidates();

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
    clearJoinAckTimer();
    socketRef.current?.removeAllListeners();
    socketRef.current?.disconnect();
    socketRef.current = null;
    activeJoinSessionRef.current = null;
    hasJoinedRoomRef.current = false;
    localPreviewModeRef.current = false;
    closeAllPeers();
    speakingMonitorsRef.current.forEach((cleanup) => cleanup());
    speakingMonitorsRef.current.clear();
    speakingSourcesRef.current = { camera: false, screen: false };
    speakingSyncRef.current = { value: false, sentAt: 0 };
    stopAllTracks(localMediaStreamRef.current);
    stopAllTracks(localScreenStreamRef.current);
    localMediaStreamRef.current = null;
    localScreenStreamRef.current = null;
    setLocalMediaStream(null);
    setLocalScreenStream(null);
  }, [clearJoinAckTimer, closeAllPeers, stopAllTracks]);

  const leaveRoom = useCallback(() => {
    const socket = socketRef.current;
    let didTeardown = false;
    const finishLeave = () => {
      if (didTeardown) {
        return;
      }

      didTeardown = true;
      teardown();
    };

    if (socket?.connected) {
      const fallbackTimer = window.setTimeout(finishLeave, 1_500);
      socket.emit('room:leave', () => {
        window.clearTimeout(fallbackTimer);
        finishLeave();
      });
    } else {
      finishLeave();
    }

    localParticipantIdRef.current = '';
    dispatch({ type: 'session/reset' });
    setErrorMessage(null);
    setJoinState('idle');
  }, [teardown]);

  const startLocalPreviewSession = useCallback(
    async ({ roomId, displayName, reason }: JoinForm & { reason?: string }) => {
      socketRef.current?.disconnect();
      socketRef.current = null;
      localPreviewModeRef.current = true;

      const participantId = `local-preview-${Math.random().toString(36).slice(2, 10)}`;
      localParticipantIdRef.current = participantId;

      dispatch({
        type: 'participants/synced',
        participants: [
          {
            id: participantId,
            displayName: displayName.trim() || 'Локальный просмотр',
            role: 'owner',
            isCameraOn: false,
            isMicOn: false,
            isSpeaking: false,
            isScreenSharing: false,
            isSharingAudio: false,
            isPinned: false,
            connectionState: 'connected'
          }
        ]
      });
      dispatch({
        type: 'chat/messageReceived',
        message: {
          id: `msg_${Date.now()}`,
          authorId: 'system',
          authorName: 'Система',
          text: reason
            ? `Для комнаты «${roomId}» включён локальный режим предпросмотра. ${reason}`
            : `Для комнаты «${roomId}» включён локальный режим предпросмотра.`,
          kind: 'system',
          createdAt: Date.now()
        }
      });

      await enumerateDevices();
      sendMediaState();
      setErrorMessage(null);
      setJoinState('joined');
    },
    [enumerateDevices, sendMediaState]
  );

  const joinRoom = useCallback(
    async ({ roomId, displayName, clientSessionId }: JoinForm) => {
      setJoinState('joining');
      setErrorMessage(null);
      dispatch({ type: 'session/reset' });
      localParticipantIdRef.current = '';
      localPreviewModeRef.current = false;
      activeJoinSessionRef.current = { roomId, displayName, clientSessionId };
      hasJoinedRoomRef.current = false;
      clearJoinAckTimer();
      socketRef.current?.removeAllListeners();
      socketRef.current?.disconnect();
      closeAllPeers();

      const allowLocalPreview = canUseLocalPreviewFallback();
      const socket = io(serverUrl, {
        transports: ['websocket']
      });

      socketRef.current = socket;

      const failInitialJoin = async (reason: string) => {
        if (hasJoinedRoomRef.current) {
          return;
        }

        clearJoinAckTimer();

        if (allowLocalPreview) {
          await startLocalPreviewSession({
            roomId,
            displayName,
            clientSessionId,
            reason
          });
          return;
        }

        socket.removeAllListeners();
        socket.disconnect();
        if (socketRef.current === socket) {
          socketRef.current = null;
        }
        activeJoinSessionRef.current = null;
        localParticipantIdRef.current = '';
        dispatch({ type: 'session/reset' });
        setErrorMessage(reason);
        setJoinState('error');
      };

      const emitJoinRequest = () => {
        const activeSession = activeJoinSessionRef.current;
        if (!activeSession) {
          return;
        }

        clearJoinAckTimer();
        joinAckTimerRef.current = window.setTimeout(() => {
          if (hasJoinedRoomRef.current) {
            updateParticipantConnectionState(localParticipantIdRef.current, 'reconnecting');
            return;
          }

          void failInitialJoin('Server did not confirm the room join in time. Check the connection and try again.');
        }, JOIN_ACK_TIMEOUT_MS);

        socket.emit('room:join', activeSession, async (response: JoinAck) => {
          clearJoinAckTimer();

          if (!response.ok) {
            if (!hasJoinedRoomRef.current) {
              await failInitialJoin(`The server rejected the join request: ${response.error}.`);
            } else {
              setErrorMessage(response.error);
            }
            return;
          }

          const isFirstJoin = !hasJoinedRoomRef.current;
          hasJoinedRoomRef.current = true;
          localParticipantIdRef.current = response.participantId;
          activeJoinSessionRef.current = {
            roomId: response.roomId,
            displayName: activeSession.displayName,
            clientSessionId: response.clientSessionId
          };

          dispatch({ type: 'participants/synced', participants: response.participants });
          dispatch({ type: 'room/policySynced', policy: response.policy });

          if (isFirstJoin) {
            response.chatMessages.forEach((message) => {
              dispatch({ type: 'chat/messageReceived', message });
            });
          }

          await enumerateDevices();
          await sendMediaState();
          setErrorMessage(null);
          setJoinState('joined');

          for (const participant of response.participants) {
            if (participant.id !== response.participantId && participant.connectionState === 'connected') {
              clearPeerRecovery(participant.id);
              await recoverPeerConnectionRef.current(participant.id);
            }
            ensureRemoteMediaRecovery(participant);
          }
        });
      };

      socket.on('connect', () => {
        if (hasJoinedRoomRef.current && localParticipantIdRef.current) {
          updateParticipantConnectionState(localParticipantIdRef.current, 'reconnecting');
        }

        emitJoinRequest();
      });

      socket.on('participant:joined', async ({ participant, message }: { participant: WireParticipant; message: ChatMessage }) => {
        dispatch({ type: 'participants/upserted', participant });
        dispatch({ type: 'chat/messageReceived', message });

        if (participant.id !== localParticipantIdRef.current) {
          clearPeerRecovery(participant.id);
          await recoverPeerConnectionRef.current(participant.id);
        }
        ensureRemoteMediaRecovery(participant);
      });

      socket.on('participant:updated', async ({ participant }: { participant: WireParticipant }) => {
        const previous = callStateRef.current.participants.find((item) => item.id === participant.id);

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

        if (
          participant.id !== localParticipantIdRef.current &&
          participant.connectionState === 'connected' &&
          previous?.connectionState === 'reconnecting'
        ) {
          clearPeerRecovery(participant.id);
          await recoverPeerConnectionRef.current(participant.id);
        }
        ensureRemoteMediaRecovery(participant);
      });

      socket.on(
        'participant:left',
        ({ participantId, participants, message }: { participantId: string; participants: WireParticipant[]; message: ChatMessage }) => {
          clearPeerRecovery(participantId);
          clearMediaRecovery(participantId);
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
        clearJoinAckTimer();

        if (!hasJoinedRoomRef.current) {
          void failInitialJoin('Connection to the room server was interrupted before the join completed.');
          return;
        }

        updateParticipantConnectionState(localParticipantIdRef.current, 'reconnecting');
      });

      socket.on('connect_error', () => {
        clearJoinAckTimer();

        if (hasJoinedRoomRef.current) {
          updateParticipantConnectionState(localParticipantIdRef.current, 'reconnecting');
          return;
        }

        void failInitialJoin('Unable to connect to the room server. Check the network and try again.');
      });
    },
    [
      clearJoinAckTimer,
      clearMediaRecovery,
      clearPeerRecovery,
      closeAllPeers,
      enumerateDevices,
      ensureRemoteMediaRecovery,
      handleSignal,
      sendMediaState,
      startLocalPreviewSession,
      updateParticipantConnectionState,
      updateRemoteStreams
    ]
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

    if (localPreviewModeRef.current) {
      dispatch({
        type: 'chat/messageReceived',
        message: {
          id: `msg_${Date.now()}`,
          authorId: localParticipantIdRef.current,
          authorName: localParticipant?.displayName ?? 'Вы',
          text,
          kind: 'user',
          createdAt: Date.now()
        }
      });
      setPendingMessage('');
      return;
    }

    socketRef.current?.emit('chat:send', { text });
    setPendingMessage('');
  }, [localParticipant?.displayName, pendingMessage]);

  const updatePolicy = useCallback((patch: Partial<RoomPolicy>) => {
    if (localPreviewModeRef.current) {
      dispatch({
        type: 'room/policySynced',
        policy: {
          ...callStateRef.current.policy,
          ...patch
        }
      });
      return;
    }

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

  const applyAudioOutput = useCallback(async (deviceId: string) => {
    setSelectedAudioOutputId(deviceId);
  }, []);

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
    selectedAudioOutputId,
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
    applyAudioOutput,
    applyVideoInput
  };
};
