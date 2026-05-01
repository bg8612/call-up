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
import {
  DEFAULT_SCREEN_SHARE_PRESET_ID,
  SCREEN_SHARE_PRESETS,
  type ScreenSharePresetId,
  getScreenSharePreset,
  isScreenSharePresetSatisfiedBySettings,
  toDisplayVideoConstraints
} from '../features/call/screen-share-quality';
import { pickAvailableDeviceId, resolveAudioInputWarning } from '../features/call/device-selection';
import {
  canApplyCandidateOrAnswer,
  hasLiveTrackByKind,
  isPeerOperationStale,
  mergeIncomingRemoteTrack,
  pruneRemoteMediaState,
  reconcileRemoteMediaBuckets,
  shouldRunRecoveryTimer,
  shouldScheduleMediaRecovery
} from './peer-stability';

type JoinForm = {
  roomId: string;
  displayName: string;
  clientSessionId: string;
  sessionToken?: string;
  anonymousAuthToken?: string;
};

type JoinAck =
  | {
      ok: true;
      participantId: string;
      clientSessionId: string;
      sessionToken?: string;
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
  version: number;
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

type RecoveryTimerEntry = {
  timer: number;
  version: number;
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

const SPEAKING_ENTER_THRESHOLD = 0.05;
const SPEAKING_LEAVE_THRESHOLD = 0.035;
const SPEAKING_ENTER_MS = 45;
const SPEAKING_LEAVE_MS = 360;
const ANALYSER_FFT_SIZE = 512;
const ANALYSER_SMOOTHING = 0.62;
const JOIN_ACK_TIMEOUT_MS = 6_000;
const SOCKET_CONNECT_TIMEOUT_MS = 12_000;
const INITIAL_JOIN_MAX_WAIT_MS = 18_000;
const CAMERA_MAX_BITRATE = 1_500_000;
const PEER_RECOVERY_DELAY_MS = 1_500;
const MEDIA_RECOVERY_GRACE_MS = 3_500;
const SPEAKING_SYNC_MIN_INTERVAL_MS = 250;
const ANONYMOUS_AUTH_TOKEN_STORAGE_KEY = 'callup:anonymous-auth-token';

const cloneRemoteMap = (source: Map<string, RemoteMediaState>) =>
  new Map([...source.entries()].map(([key, value]) => [key, { ...value }]));

const generateAnonymousAuthToken = () => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `anon_${crypto.randomUUID()}`;
  }

  return `anon_${Math.random().toString(36).slice(2, 12)}${Date.now().toString(36)}`;
};

const ensureAnonymousAuthToken = () => {
  if (typeof window === 'undefined') {
    return generateAnonymousAuthToken();
  }

  const existing = window.localStorage.getItem(ANONYMOUS_AUTH_TOKEN_STORAGE_KEY)?.trim();
  if (existing) {
    return existing;
  }

  const nextToken = generateAnonymousAuthToken();
  window.localStorage.setItem(ANONYMOUS_AUTH_TOKEN_STORAGE_KEY, nextToken);
  return nextToken;
};

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

    if (rms > SPEAKING_ENTER_THRESHOLD) {
      aboveThresholdSince = aboveThresholdSince || now;
      belowThresholdSince = 0;
      if (!speaking && now - aboveThresholdSince >= SPEAKING_ENTER_MS) {
        speaking = true;
        onSpeakingChange(true);
      }
    } else {
      if (rms < SPEAKING_LEAVE_THRESHOLD) {
        belowThresholdSince = belowThresholdSince || now;
        aboveThresholdSince = 0;
        if (speaking && now - belowThresholdSince >= SPEAKING_LEAVE_MS) {
          speaking = false;
          onSpeakingChange(false);
        }
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
  const [selectedScreenSharePresetId, setSelectedScreenSharePresetId] =
    useState<ScreenSharePresetId>(DEFAULT_SCREEN_SHARE_PRESET_ID);
  const [localMediaStream, setLocalMediaStream] = useState<MediaStream | null>(null);
  const [localScreenStream, setLocalScreenStream] = useState<MediaStream | null>(null);
  const [remoteStreams, setRemoteStreams] = useState<Map<string, RemoteMediaState>>(new Map());
  const [activePanel, setActivePanel] = useState<'chat' | 'participants' | 'settings'>('chat');
  const [pendingMessage, setPendingMessage] = useState('');
  const [isConnectingMedia, setIsConnectingMedia] = useState(false);
  const [resolvedSessionToken, setResolvedSessionToken] = useState('');
  const socketRef = useRef<Socket | null>(null);
  const peersRef = useRef<Map<string, PeerRecord>>(new Map());
  const peerRecoveryTimersRef = useRef<Map<string, RecoveryTimerEntry>>(new Map());
  const mediaRecoveryTimersRef = useRef<Map<string, RecoveryTimerEntry>>(new Map());
  const peerVersionsRef = useRef<Map<string, number>>(new Map());
  const remoteStreamsRef = useRef<Map<string, RemoteMediaState>>(new Map());
  const localParticipantIdRef = useRef<string>('');
  const localMediaStreamRef = useRef<MediaStream | null>(null);
  const localScreenStreamRef = useRef<MediaStream | null>(null);
  const callStateRef = useRef(callState);
  const speakingMonitorsRef = useRef<Map<string, SpeakingMonitorCleanup>>(new Map());
  const speakingSourcesRef = useRef<Record<SpeakingSource, boolean>>({ camera: false, screen: false });
  const speakingSyncRef = useRef<{ value: boolean; sentAt: number }>({ value: false, sentAt: 0 });
  const selectedScreenSharePresetIdRef = useRef<ScreenSharePresetId>(DEFAULT_SCREEN_SHARE_PRESET_ID);
  const localPreviewModeRef = useRef(false);
  const activeJoinSessionRef = useRef<JoinForm | null>(null);
  const joinAckTimerRef = useRef<number | null>(null);
  const initialJoinTimerRef = useRef<number | null>(null);
  const hasJoinedRoomRef = useRef(false);
  const leaveOperationIdRef = useRef(0);
  const joinAttemptCounterRef = useRef(0);
  const preJoinConnectErrorsRef = useRef(0);
  const signalSequenceRef = useRef(0);
  const negotiatePeerConnectionRef = useRef<(participantId: string, iceRestart?: boolean) => Promise<void>>(
    async () => undefined
  );
  const recoverPeerConnectionRef = useRef<(participantId: string, iceRestart?: boolean) => Promise<void>>(
    async () => undefined
  );

  useEffect(() => {
    callStateRef.current = callState;
  }, [callState]);

  useEffect(() => {
    selectedScreenSharePresetIdRef.current = selectedScreenSharePresetId;
  }, [selectedScreenSharePresetId]);

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

  const clearInitialJoinTimer = useCallback(() => {
    if (initialJoinTimerRef.current === null) {
      return;
    }

    window.clearTimeout(initialJoinTimerRef.current);
    initialJoinTimerRef.current = null;
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
    const timerEntry = peerRecoveryTimersRef.current.get(participantId);
    if (!timerEntry) {
      return;
    }

    window.clearTimeout(timerEntry.timer);
    peerRecoveryTimersRef.current.delete(participantId);
  }, []);

  const clearMediaRecovery = useCallback((participantId: string) => {
    const timerEntry = mediaRecoveryTimersRef.current.get(participantId);
    if (!timerEntry) {
      return;
    }

    window.clearTimeout(timerEntry.timer);
    mediaRecoveryTimersRef.current.delete(participantId);
  }, []);

  const getPeerVersion = useCallback((participantId: string) => peerVersionsRef.current.get(participantId) ?? 0, []);

  const allocatePeerVersion = useCallback((participantId: string) => {
    const nextVersion = getPeerVersion(participantId) + 1;
    peerVersionsRef.current.set(participantId, nextVersion);
    return nextVersion;
  }, [getPeerVersion]);

  const hasExpectedRemoteMedia = useCallback((participantId: string, participant: Participant) => {
    const media = remoteStreamsRef.current.get(participantId);
    const hasCameraTrack = hasLiveTrackByKind(media?.cameraStream, 'video');
    const hasMicTrack = hasLiveTrackByKind(media?.cameraStream, 'audio');
    const hasScreenTrack = hasLiveTrackByKind(media?.screenStream, 'video');
    const hasScreenAudio = hasLiveTrackByKind(media?.screenStream, 'audio');

    const cameraSatisfied = !participant.isCameraOn || hasCameraTrack;
    const micSatisfied = !participant.isMicOn || hasMicTrack;
    const screenSatisfied = !participant.isScreenSharing || hasScreenTrack;
    const screenAudioSatisfied = !participant.isSharingAudio || hasScreenAudio;
    return cameraSatisfied && micSatisfied && screenSatisfied && screenAudioSatisfied;
  }, []);

  const ensureRemoteMediaRecovery = useCallback(
    (participant: Participant) => {
      const expectsAnyMedia = participant.isCameraOn || participant.isMicOn || participant.isScreenSharing || participant.isSharingAudio;
      const hasTimer = mediaRecoveryTimersRef.current.has(participant.id);
      const shouldSchedule = shouldScheduleMediaRecovery({
        participantConnectionState: participant.connectionState,
        isLocalParticipant: participant.id === localParticipantIdRef.current,
        hasAnyExpectedMedia: expectsAnyMedia,
        alreadyScheduled: hasTimer,
        hasExpectedRemoteMedia: hasExpectedRemoteMedia(participant.id, participant)
      });
      if (!shouldSchedule) {
        clearMediaRecovery(participant.id);
        return;
      }

      const expectedVersion = getPeerVersion(participant.id);
      const timer = window.setTimeout(() => {
        const current = mediaRecoveryTimersRef.current.get(participant.id);
        mediaRecoveryTimersRef.current.delete(participant.id);
        if (
          !current ||
          !shouldRunRecoveryTimer({
            timerVersion: current.version,
            currentVersion: expectedVersion
          })
        ) {
          console.log('[rtc] media recovery timer ignored stale version', {
            participantId: participant.id,
            expectedVersion,
            currentVersion: current?.version
          });
          return;
        }
        console.log('[rtc] media recovery timer fired', { participantId: participant.id, peerVersion: expectedVersion });
        void recoverPeerConnectionRef.current(participant.id, true);
      }, MEDIA_RECOVERY_GRACE_MS);

      mediaRecoveryTimersRef.current.set(participant.id, {
        timer,
        version: expectedVersion
      });
      console.log('[rtc] media recovery timer scheduled', {
        participantId: participant.id,
        peerVersion: expectedVersion,
        delayMs: MEDIA_RECOVERY_GRACE_MS
      });
    },
    [clearMediaRecovery, getPeerVersion, hasExpectedRemoteMedia]
  );

  const schedulePeerRecovery = useCallback(
    (participantId: string, iceRestart = false) => {
      if (peerRecoveryTimersRef.current.has(participantId)) {
        return;
      }

      const expectedVersion = getPeerVersion(participantId);
      const timer = window.setTimeout(() => {
        const current = peerRecoveryTimersRef.current.get(participantId);
        peerRecoveryTimersRef.current.delete(participantId);
        if (
          !current ||
          !shouldRunRecoveryTimer({
            timerVersion: current.version,
            currentVersion: expectedVersion
          })
        ) {
          console.log('[rtc] peer recovery timer ignored stale version', {
            participantId,
            expectedVersion,
            currentVersion: current?.version
          });
          return;
        }
        console.log('[rtc] peer recovery timer fired', { participantId, peerVersion: expectedVersion });
        void recoverPeerConnectionRef.current(participantId, iceRestart);
      }, PEER_RECOVERY_DELAY_MS);

      peerRecoveryTimersRef.current.set(participantId, {
        timer,
        version: expectedVersion
      });
      console.log('[rtc] peer recovery timer scheduled', {
        participantId,
        peerVersion: expectedVersion,
        delayMs: PEER_RECOVERY_DELAY_MS
      });
    },
    [getPeerVersion]
  );

  const configureSenderParameters = useCallback(
    async (sender: RTCRtpSender | undefined, senderKey: keyof PeerRecord['senders']) => {
      if (
        !sender ||
        (senderKey !== 'cameraVideo' && senderKey !== 'screenVideo') ||
        typeof sender.getParameters !== 'function'
      ) {
        return;
      }

      const parameters = sender.getParameters();
      parameters.degradationPreference = 'balanced';
      parameters.encodings = parameters.encodings?.length ? parameters.encodings : [{}];
      const maxBitrate =
        senderKey === 'cameraVideo'
          ? CAMERA_MAX_BITRATE
          : getScreenSharePreset(selectedScreenSharePresetIdRef.current).maxBitrate;
      parameters.encodings[0] = {
        ...parameters.encodings[0],
        maxBitrate
      };

      try {
        await sender.setParameters(parameters);
      } catch (error) {
        console.warn('Failed to configure sender parameters', { senderKey, error });
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

    setSelectedAudioInputId((current) => {
      const picked = pickAvailableDeviceId(
        current,
        nextDevices.audioInputs.map((device) => device.deviceId)
      );
      if (picked.changed && picked.deviceId !== current) {
        console.warn('[media] selected audio input is unavailable, fallback applied', {
          previousDeviceId: current,
          fallbackDeviceId: picked.deviceId || '(none)'
        });
      }
      return picked.deviceId;
    });
    setSelectedAudioOutputId((current) => {
      if (!current) {
        return '';
      }

      return nextDevices.audioOutputs.some((device) => device.deviceId === current) ? current : '';
    });
    setSelectedVideoInputId((current) => {
      return pickAvailableDeviceId(
        current,
        nextDevices.videoInputs.map((device) => device.deviceId)
      ).deviceId;
    });
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
    const hasLiveTrack = (track: MediaStreamTrack | null | undefined) =>
      Boolean(track && track.readyState === 'live' && track.enabled);
    const hasLiveVideoTrack = (track: MediaStreamTrack | null | undefined) =>
      Boolean(track && track.readyState === 'live');
    const mediaState = {
      isCameraOn: hasLiveTrack(cameraVideoTrack),
      isMicOn: hasLiveTrack(cameraAudioTrack),
      isScreenSharing: hasLiveVideoTrack(getTrackByKind(screenStream, 'video')),
      isSharingAudio: hasLiveTrack(screenAudioTrack),
      cameraStreamId: hasLiveVideoTrack(cameraVideoTrack) || hasLiveTrack(cameraAudioTrack) ? cameraStream?.id : undefined,
      screenStreamId: hasLiveVideoTrack(getTrackByKind(screenStream, 'video')) || hasLiveTrack(screenAudioTrack) ? screenStream?.id : undefined
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

  const disposeParticipantPeer = useCallback(
    (participantId: string, reason: string, removeRemoteState = true) => {
      clearPeerRecovery(participantId);
      clearMediaRecovery(participantId);

      const existing = peersRef.current.get(participantId);
      if (existing) {
        existing.pendingIceCandidates = [];
        existing.pc.close();
        peersRef.current.delete(participantId);
        console.log('[rtc] peer disposed', {
          participantId,
          peerVersion: existing.version,
          reason
        });
      }

      if (removeRemoteState) {
        updateRemoteStreams((draft) => {
          draft.delete(participantId);
        });
      }
    },
    [clearMediaRecovery, clearPeerRecovery, updateRemoteStreams]
  );

  const ensurePeerRecord = useCallback(
    (remoteParticipantId: string, forceRecreate = false) => {
      const existing = peersRef.current.get(remoteParticipantId);
      if (existing && !forceRecreate) {
        return existing;
      }

      if (existing && forceRecreate) {
        disposeParticipantPeer(remoteParticipantId, 'force-recreate', false);
      }

      const version = allocatePeerVersion(remoteParticipantId);
      const polite = localParticipantIdRef.current.localeCompare(remoteParticipantId) > 0;
      const pc = new RTCPeerConnection(rtcConfig);
      const peerRecord: PeerRecord = {
        pc,
        version,
        polite,
        makingOffer: false,
        ignoreOffer: false,
        isSettingRemoteAnswerPending: false,
        pendingIceCandidates: [],
        senders: {}
      };

      pc.onicecandidate = (event) => {
        if (peerRecord.version !== getPeerVersion(remoteParticipantId) || String(pc.connectionState) === 'closed') {
          return;
        }
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
        if (peerRecord.version !== getPeerVersion(remoteParticipantId)) {
          return;
        }
        if (pc.connectionState === 'connected') {
          clearPeerRecovery(remoteParticipantId);
          console.log('[rtc] peer connected', { participantId: remoteParticipantId, peerVersion: peerRecord.version });
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

        if (String(pc.connectionState) === 'closed') {
          clearPeerRecovery(remoteParticipantId);
        }
        console.log('[rtc] peer connection state changed', {
          participantId: remoteParticipantId,
          peerVersion: peerRecord.version,
          state: pc.connectionState
        });
      };

      pc.ontrack = (event) => {
        if (peerRecord.version !== getPeerVersion(remoteParticipantId) || String(pc.connectionState) === 'closed') {
          return;
        }
        const participant = callStateRef.current.participants.find((item) => item.id === remoteParticipantId);
        if (!participant) {
          return;
        }
        const incomingStream = event.streams[0];

        console.log('[rtc] remote track received', {
          participantId: remoteParticipantId,
          peerVersion: peerRecord.version,
          trackKind: event.track.kind,
          trackId: event.track.id,
          streamCount: event.streams.length,
          streamId: incomingStream?.id
        });

        updateRemoteStreams((draft) => {
          const current = draft.get(remoteParticipantId) ?? {};
          const next = mergeIncomingRemoteTrack({
            current,
            participant,
            track: event.track,
            incomingStream
          });
          const pruned = pruneRemoteMediaState(next);
          if (!pruned.cameraStream && !pruned.screenStream) {
            draft.delete(remoteParticipantId);
            return;
          }
          draft.set(remoteParticipantId, pruned);
        });

        const handleRemoteTrackStateChange = () => {
          const currentParticipant = callStateRef.current.participants.find((item) => item.id === remoteParticipantId);
          if (!currentParticipant) {
            return;
          }

          updateRemoteStreams((draft) => {
            const current = draft.get(remoteParticipantId);
            if (!current) {
              return;
            }
            const pruned = pruneRemoteMediaState(current);
            if (!pruned.cameraStream && !pruned.screenStream) {
              draft.delete(remoteParticipantId);
              return;
            }
            draft.set(remoteParticipantId, pruned);
          });
          ensureRemoteMediaRecovery(currentParticipant);
        };
        event.track.addEventListener('ended', handleRemoteTrackStateChange);
        event.track.addEventListener('mute', handleRemoteTrackStateChange);
        event.track.addEventListener('unmute', handleRemoteTrackStateChange);

        ensureRemoteMediaRecovery(participant);
      };

      pc.onnegotiationneeded = async () => {
        if (peerRecord.version !== getPeerVersion(remoteParticipantId) || String(pc.connectionState) === 'closed') {
          return;
        }
        await negotiatePeerConnectionRef.current(remoteParticipantId);
      };

      console.log('[rtc] peer created', { participantId: remoteParticipantId, peerVersion: version });
      peersRef.current.set(remoteParticipantId, peerRecord);
      return peerRecord;
    },
    [
      allocatePeerVersion,
      clearPeerRecovery,
      disposeParticipantPeer,
      ensureRemoteMediaRecovery,
      getPeerVersion,
      schedulePeerRecovery,
      updateRemoteStreams
    ]
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
      const expectedVersion = peer.version;
      if (peer.makingOffer || peer.pc.signalingState !== 'stable') {
        return;
      }

      try {
        peer.makingOffer = true;
        const negotiationAttemptId = `${remoteParticipantId}:v${expectedVersion}:${Date.now()}`;
        console.log('[rtc] negotiation start', {
          negotiationAttemptId,
          participantId: remoteParticipantId,
          peerVersion: expectedVersion,
          iceRestart
        });
        await syncPeerTracks(remoteParticipantId);
        const currentPeer = peersRef.current.get(remoteParticipantId);
        if (!currentPeer || currentPeer.version !== expectedVersion || String(currentPeer.pc.connectionState) === 'closed') {
          console.log('[rtc] negotiation skipped stale peer', {
            negotiationAttemptId,
            participantId: remoteParticipantId,
            peerVersion: expectedVersion
          });
          return;
        }
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
        console.log('[rtc] negotiation completed', {
          negotiationAttemptId,
          participantId: remoteParticipantId,
          peerVersion: expectedVersion
        });
      } catch (error) {
        console.error('Negotiation failed', error);
      } finally {
        const currentPeer = peersRef.current.get(remoteParticipantId);
        if (currentPeer?.version === expectedVersion) {
          currentPeer.makingOffer = false;
        }
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
        console.log('[rtc] peer recovery ice restart', {
          participantId: remoteParticipantId,
          peerVersion: existing.version
        });
        await negotiatePeerConnection(remoteParticipantId, true);
        return;
      }

      if (existing) {
        disposeParticipantPeer(remoteParticipantId, 'recovery-recreate', false);
      } else {
        clearPeerRecovery(remoteParticipantId);
      }
      ensurePeerRecord(remoteParticipantId, true);
      await negotiatePeerConnection(remoteParticipantId, false);
    },
    [clearPeerRecovery, disposeParticipantPeer, ensurePeerRecord, negotiatePeerConnection]
  );

  recoverPeerConnectionRef.current = recoverPeerConnection;

  const closeAllPeers = useCallback(() => {
    Array.from(peersRef.current.keys()).forEach((participantId) => {
      disposeParticipantPeer(participantId, 'close-all-peers');
    });
    peerRecoveryTimersRef.current.forEach(({ timer }) => window.clearTimeout(timer));
    mediaRecoveryTimersRef.current.forEach(({ timer }) => window.clearTimeout(timer));
    peerRecoveryTimersRef.current.clear();
    mediaRecoveryTimersRef.current.clear();
    remoteStreamsRef.current = new Map();
    setRemoteStreams(new Map());
  }, [disposeParticipantPeer]);

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
        const buildConstraints = (targetDeviceId?: string) =>
          kind === 'audio'
            ? { audio: targetDeviceId ? { deviceId: { exact: targetDeviceId } } : true, video: false }
            : {
                audio: false,
                video: {
                  deviceId: targetDeviceId ? { exact: targetDeviceId } : undefined,
                  width: { ideal: 1280 },
                  height: { ideal: 720 },
                  frameRate: { ideal: 24, max: 30 }
                }
              };

        let requested: MediaStream;
        let usedFallbackDevice = false;
        try {
          requested = await navigator.mediaDevices.getUserMedia(buildConstraints(deviceId));
        } catch (error) {
          const mediaError = error as DOMException | Error;
          const shouldRetryWithoutDevice =
            Boolean(deviceId) &&
            (mediaError?.name === 'OverconstrainedError' ||
              mediaError?.name === 'NotFoundError' ||
              mediaError?.name === 'DevicesNotFoundError');

          if (!shouldRetryWithoutDevice) {
            throw error;
          }

          console.warn('[media] failed to open requested device, retrying default device', {
            kind,
            deviceId,
            errorName: mediaError?.name
          });
          usedFallbackDevice = true;
          requested = await navigator.mediaDevices.getUserMedia(buildConstraints(undefined));
        }
        const track = getTrackByKind(requested, kind);

        if (!track) {
          throw new Error(`No ${kind} track returned by getUserMedia`);
        }

        if (kind === 'video') {
          track.contentHint = 'motion';
        }

        track.addEventListener('ended', () => {
          void syncAllPeerTracks();
          void sendMediaState();
        });

        track.enabled = enabled;
        await replaceLocalTrack(kind, track);
        const actualDeviceId = track.getSettings().deviceId;
        if (kind === 'audio') {
          console.log('[media] audio input track applied', {
            requestedDeviceId: deviceId || '(default)',
            actualDeviceId: actualDeviceId || '(unknown)',
            usedFallbackDevice
          });
          const warning = resolveAudioInputWarning({
            requestedDeviceId: deviceId,
            actualDeviceId,
            usedFallbackDevice
          });
          if (warning) {
            setErrorMessage(warning);
          }
        }
        await enumerateDevices();
      } catch (error) {
        console.error(error);
        const mediaError = error as DOMException | Error;
        const accessDenied =
          mediaError?.name === 'NotAllowedError' || mediaError?.name === 'PermissionDeniedError';
        setErrorMessage(
          kind === 'audio'
            ? accessDenied
              ? 'Не удалось включить микрофон: доступ запрещён. Разрешите микрофон в браузере и нажмите кнопку микрофона повторно.'
              : 'Не удалось включить микрофон. Проверьте доступ браузера к устройству и повторите попытку.'
            : accessDenied
              ? 'Не удалось включить камеру: доступ запрещён. Разрешите камеру в браузере и нажмите кнопку камеры повторно.'
              : 'Не удалось включить камеру. Проверьте доступ браузера к устройству и повторите попытку.'
        );
      } finally {
        setIsConnectingMedia(false);
      }
    },
    [enumerateDevices, replaceLocalTrack, sendMediaState, syncAllPeerTracks]
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
      const remoteParticipant = callStateRef.current.participants.find((item) => item.id === fromParticipantId);
      if (!remoteParticipant || remoteParticipant.connectionState !== 'connected') {
        console.log('[rtc] signal ignored for non-active participant', {
          participantId: fromParticipantId,
          signalType: signal.type
        });
        return;
      }

      const peer = ensurePeerRecord(fromParticipantId);
      const expectedVersion = peer.version;
      const isStalePeer = () => {
        const currentPeer = peersRef.current.get(fromParticipantId);
        return (
          !currentPeer ||
          isPeerOperationStale({
            currentVersion: currentPeer.version,
            expectedVersion,
            signalingState: currentPeer.pc.signalingState
          })
        );
      };
      if (isStalePeer()) {
        console.log('[rtc] signal ignored for stale peer', {
          participantId: fromParticipantId,
          peerVersion: expectedVersion,
          signalType: signal.type
        });
        return;
      }

      const readyForOffer =
        !peer.makingOffer && (peer.pc.signalingState === 'stable' || peer.isSettingRemoteAnswerPending);

      const flushPendingIceCandidates = async () => {
        if (peer.pendingIceCandidates.length === 0) {
          return;
        }

        const queuedCandidates = [...peer.pendingIceCandidates];
        peer.pendingIceCandidates = [];

        for (const queuedCandidate of queuedCandidates) {
          if (isStalePeer()) {
            return;
          }
          try {
            await peer.pc.addIceCandidate(queuedCandidate);
          } catch (error) {
            console.error('Failed to apply queued ICE candidate', error);
          }
        }
      };

      if (signal.type === 'candidate') {
        if (
          !canApplyCandidateOrAnswer({
            signalingState: peer.pc.signalingState,
            currentVersion: peersRef.current.get(fromParticipantId)?.version,
            expectedVersion
          }) ||
          isStalePeer()
        ) {
          console.log('[rtc] candidate ignored for closed/stale peer', {
            participantId: fromParticipantId,
            peerVersion: expectedVersion
          });
          return;
        }
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
        console.log('[rtc] signal ignored due to offer collision policy', {
          participantId: fromParticipantId,
          peerVersion: expectedVersion
        });
        return;
      }

      if (offerCollision) {
        if (String(peer.pc.connectionState) === 'closed' || isStalePeer()) {
          return;
        }
        await peer.pc.setLocalDescription({ type: 'rollback' });
      }

      if (String(peer.pc.connectionState) === 'closed' || isStalePeer()) {
        console.log('[rtc] description ignored for closed/stale peer', {
          participantId: fromParticipantId,
          peerVersion: expectedVersion,
          descriptionType: description.type
        });
        return;
      }
      peer.isSettingRemoteAnswerPending = description.type === 'answer';
      await peer.pc.setRemoteDescription(description);
      peer.isSettingRemoteAnswerPending = false;
      await flushPendingIceCandidates();

      if (description.type === 'offer') {
        if (isStalePeer()) {
          return;
        }
        await syncPeerTracks(fromParticipantId);
        if (String(peer.pc.connectionState) === 'closed' || isStalePeer()) {
          return;
        }
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
    clearInitialJoinTimer();
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
  }, [clearInitialJoinTimer, clearJoinAckTimer, closeAllPeers, stopAllTracks]);

  const leaveRoom = useCallback(() => {
    const socket = socketRef.current;
    const leaveOperationId = ++leaveOperationIdRef.current;
    let didTeardown = false;
    const finishLeave = () => {
      if (didTeardown) {
        return;
      }
      if (leaveOperationId !== leaveOperationIdRef.current) {
        return;
      }

      didTeardown = true;
      console.log('[room] leave finalized', { leaveOperationId });
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
    console.log('[room] leave started', { leaveOperationId, hadSocket: Boolean(socket) });
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
    async ({ roomId, displayName, clientSessionId, sessionToken, anonymousAuthToken }: JoinForm) => {
      leaveOperationIdRef.current += 1;
      setJoinState('joining');
      setErrorMessage(null);
      setResolvedSessionToken('');
      dispatch({ type: 'session/reset' });
      localParticipantIdRef.current = '';
      localPreviewModeRef.current = false;
      const resolvedAnonymousAuthToken = anonymousAuthToken || ensureAnonymousAuthToken();
      activeJoinSessionRef.current = {
        roomId,
        displayName,
        clientSessionId,
        sessionToken,
        anonymousAuthToken: resolvedAnonymousAuthToken
      };
      hasJoinedRoomRef.current = false;
      preJoinConnectErrorsRef.current = 0;
      clearJoinAckTimer();
      clearInitialJoinTimer();
      socketRef.current?.removeAllListeners();
      socketRef.current?.disconnect();
      closeAllPeers();

      const allowLocalPreview = canUseLocalPreviewFallback();
      const socket = io(serverUrl, {
        transports: ['polling', 'websocket'],
        tryAllTransports: true,
        forceNew: true,
        timeout: SOCKET_CONNECT_TIMEOUT_MS,
        reconnection: true,
        reconnectionAttempts: 2,
        reconnectionDelay: 1_000,
        reconnectionDelayMax: 3_000
      });

      socketRef.current = socket;

      const failInitialJoin = async (reason: string) => {
        if (hasJoinedRoomRef.current) {
          return;
        }

        clearJoinAckTimer();
        clearInitialJoinTimer();

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

      initialJoinTimerRef.current = window.setTimeout(() => {
        if (hasJoinedRoomRef.current) {
          return;
        }

        void failInitialJoin('Unable to connect to the room server. Check the network and try again.');
      }, INITIAL_JOIN_MAX_WAIT_MS);

      const emitJoinRequest = () => {
        const activeSession = activeJoinSessionRef.current;
        if (!activeSession) {
          return;
        }
        const joinAttemptId = `${activeSession.roomId}:${++joinAttemptCounterRef.current}`;
        console.log('[room] join attempt started', {
          joinAttemptId,
          roomId: activeSession.roomId
        });

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
          console.log('[room] join attempt ack', {
            joinAttemptId,
            roomId: response.roomId,
            participantId: response.participantId,
            participantsCount: response.participants.length
          });

          const isFirstJoin = !hasJoinedRoomRef.current;
          hasJoinedRoomRef.current = true;
          clearInitialJoinTimer();
          localParticipantIdRef.current = response.participantId;
          const nextSessionToken = response.sessionToken || response.clientSessionId;
          setResolvedSessionToken(nextSessionToken);
          activeJoinSessionRef.current = {
            roomId: response.roomId,
            displayName: activeSession.displayName,
            clientSessionId: activeSession.clientSessionId,
            sessionToken: nextSessionToken,
            anonymousAuthToken: activeSession.anonymousAuthToken
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
        console.log('[socket] connected', {
          socketId: socket.id,
          preJoinConnectErrors: preJoinConnectErrorsRef.current
        });
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
          const reconciled = reconcileRemoteMediaBuckets({ current, participant });
          const pruned = pruneRemoteMediaState(reconciled);
          if (!pruned.cameraStream && !pruned.screenStream) {
            draft.delete(participant.id);
            return;
          }
          draft.set(participant.id, pruned);
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
          disposeParticipantPeer(participantId, 'participant-left');
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
          const signalSeq = ++signalSequenceRef.current;
          console.log('[rtc] signal received', {
            signalSeq,
            fromParticipantId,
            signalType: signal.type
          });
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
          console.warn('[socket] disconnected before join completed', {
            socketId: socket.id,
            active: socket.active
          });
          return;
        }

        updateParticipantConnectionState(localParticipantIdRef.current, 'reconnecting');
      });

      socket.on('connect_error', (error: Error & { description?: unknown; context?: unknown }) => {
        preJoinConnectErrorsRef.current += 1;
        console.warn('[socket] connect error', {
          socketId: socket.id,
          attempt: preJoinConnectErrorsRef.current,
          active: socket.active,
          message: error?.message,
          description: error?.description,
          context: error?.context
        });

        if (hasJoinedRoomRef.current) {
          updateParticipantConnectionState(localParticipantIdRef.current, 'reconnecting');
          return;
        }
      });

      socket.io.on('reconnect_attempt', (attempt) => {
        console.log('[socket.io] reconnect attempt', {
          attempt,
          joined: hasJoinedRoomRef.current
        });
      });

      socket.io.on('reconnect_failed', () => {
        if (hasJoinedRoomRef.current) {
          return;
        }

        void failInitialJoin('Unable to connect to the room server. Check the network and try again.');
      });
    },
    [
      clearInitialJoinTimer,
      clearJoinAckTimer,
      clearPeerRecovery,
      closeAllPeers,
      disposeParticipantPeer,
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

  const applyScreenSharePreset = useCallback(
    async (presetId: ScreenSharePresetId) => {
      setSelectedScreenSharePresetId(presetId);
      selectedScreenSharePresetIdRef.current = presetId;

      const stream = localScreenStreamRef.current;
      const videoTrack = getTrackByKind(stream, 'video');
      if (!videoTrack) {
        return;
      }

      const preset = getScreenSharePreset(presetId);
      try {
        await videoTrack.applyConstraints(toDisplayVideoConstraints(preset));
      } catch (error) {
        console.warn('Failed to apply screen share constraints', { presetId, error });
      }

      await syncAllPeerTracks();
      await sendMediaState();
    },
    [sendMediaState, syncAllPeerTracks]
  );

  const verifyScreenShareQuality = useCallback(
    async (videoTrack: MediaStreamTrack, presetId: ScreenSharePresetId) => {
      const preset = getScreenSharePreset(presetId);
      const settings = videoTrack.getSettings();
      const settingsOk = isScreenSharePresetSatisfiedBySettings(preset, {
        width: settings.width,
        height: settings.height,
        frameRate: settings.frameRate
      });

      let senderFps: number | undefined;
      const firstPeer = peersRef.current.values().next().value as PeerRecord | undefined;
      const sender = firstPeer?.senders.screenVideo;
      if (sender && typeof sender.getStats === 'function') {
        try {
          const stats = await sender.getStats();
          for (const stat of stats.values()) {
            if (stat.type === 'outbound-rtp' && stat.kind === 'video') {
              senderFps = stat.framesPerSecond;
              break;
            }
          }
        } catch (error) {
          console.warn('[screen-share] sender stats read failed', { presetId, error });
        }
      }

      const fpsTarget = Math.floor(preset.fps * 0.9);
      const senderFpsOk = senderFps === undefined ? true : senderFps >= fpsTarget;
      const verified = settingsOk && senderFpsOk;

      console.log('[screen-share] quality verification', {
        presetId,
        requested: { width: preset.width, height: preset.height, fps: preset.fps },
        actual: {
          width: settings.width,
          height: settings.height,
          frameRate: settings.frameRate,
          senderFps
        },
        verified
      });

      if (!verified) {
        setErrorMessage(
          `Не удалось подтвердить режим ${preset.label}: фактически ${settings.width ?? '?'}x${settings.height ?? '?'} @ ${
            Math.round(settings.frameRate ?? 0) || '?'
          } FPS.`
        );
      }
    },
    []
  );

  const startScreenShare = useCallback(async () => {
    try {
      const canShareAudio = callStateRef.current.policy.allowSystemAudio;
      const presetId = selectedScreenSharePresetIdRef.current;
      const preset = getScreenSharePreset(presetId);
      const displayStream = await navigator.mediaDevices.getDisplayMedia({
        video: toDisplayVideoConstraints(preset),
        audio: canShareAudio
      });

      const screenVideoTrack = displayStream.getVideoTracks()[0] ?? null;
      screenVideoTrack?.addEventListener('ended', () => {
        void stopScreenShare();
      });

      const previous = localScreenStreamRef.current;
      localScreenStreamRef.current = displayStream;
      setLocalScreenStream(displayStream);
      stopAllTracks(previous);

      await syncAllPeerTracks();
      sendMediaState();
      if (screenVideoTrack) {
        window.setTimeout(() => {
          void verifyScreenShareQuality(screenVideoTrack, presetId);
        }, 1_200);
      }
    } catch (error) {
      console.error(error);
      setErrorMessage('Не удалось запустить демонстрацию экрана.');
    }
  }, [sendMediaState, stopAllTracks, stopScreenShare, syncAllPeerTracks, verifyScreenShareQuality]);

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
      const shouldEnable = existing ? existing.enabled : true;
      await requestTrack('audio', deviceId, shouldEnable);
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
    selectedScreenSharePresetId,
    screenSharePresets: SCREEN_SHARE_PRESETS,
    pendingMessage,
    activePanel,
    isConnectingMedia,
    resolvedSessionToken,
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
    applyVideoInput,
    applyScreenSharePreset
  };
};
