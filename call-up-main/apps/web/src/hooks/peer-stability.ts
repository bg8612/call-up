import type { Participant, RemoteMediaState } from '../features/call/types';

export const isPeerOperationStale = ({
  currentVersion,
  expectedVersion,
  signalingState
}: {
  currentVersion: number | undefined;
  expectedVersion: number;
  signalingState: string;
}) => {
  return currentVersion !== expectedVersion || signalingState === 'closed';
};

export const shouldRunRecoveryTimer = ({
  timerVersion,
  currentVersion
}: {
  timerVersion: number | undefined;
  currentVersion: number;
}) => timerVersion === currentVersion;

export const canApplyCandidateOrAnswer = ({
  signalingState,
  currentVersion,
  expectedVersion
}: {
  signalingState: string;
  currentVersion: number | undefined;
  expectedVersion: number;
}) => !isPeerOperationStale({ currentVersion, expectedVersion, signalingState });

export const shouldScheduleMediaRecovery = ({
  participantConnectionState,
  isLocalParticipant,
  hasAnyExpectedMedia,
  alreadyScheduled,
  hasExpectedRemoteMedia
}: {
  participantConnectionState: 'connected' | 'reconnecting';
  isLocalParticipant: boolean;
  hasAnyExpectedMedia: boolean;
  alreadyScheduled: boolean;
  hasExpectedRemoteMedia: boolean;
}) => {
  if (isLocalParticipant || participantConnectionState !== 'connected') {
    return false;
  }
  if (!hasAnyExpectedMedia || hasExpectedRemoteMedia || alreadyScheduled) {
    return false;
  }

  return true;
};

export const removeParticipantFromRemoteState = <T>(state: Map<string, T>, participantId: string) => {
  const next = new Map(state);
  next.delete(participantId);
  return next;
};

type RemoteBucket = keyof RemoteMediaState;

const isLiveTrack = (track: MediaStreamTrack | null | undefined) =>
  Boolean(track && track.readyState === 'live');

const pruneEndedTracks = (stream: MediaStream | undefined) => {
  if (!stream) {
    return undefined;
  }

  for (const track of stream.getTracks()) {
    if (track.readyState === 'ended') {
      stream.removeTrack(track);
    }
  }

  return stream.getTracks().length > 0 ? stream : undefined;
};

export const hasLiveTrackByKind = (stream: MediaStream | undefined, kind: 'audio' | 'video') => {
  if (!stream) {
    return false;
  }

  const tracks = kind === 'audio' ? stream.getAudioTracks() : stream.getVideoTracks();
  return tracks.some((track) => isLiveTrack(track));
};

export const pruneRemoteMediaState = (state: RemoteMediaState): RemoteMediaState => {
  return {
    cameraStream: pruneEndedTracks(state.cameraStream),
    screenStream: pruneEndedTracks(state.screenStream)
  };
};

const createMutableMediaStream = () => {
  if (typeof MediaStream !== 'undefined') {
    return new MediaStream();
  }

  const tracks: MediaStreamTrack[] = [];
  return {
    getTracks: () => [...tracks],
    getAudioTracks: () => tracks.filter((track) => track.kind === 'audio'),
    getVideoTracks: () => tracks.filter((track) => track.kind === 'video'),
    addTrack: (track: MediaStreamTrack) => {
      if (!tracks.includes(track)) {
        tracks.push(track);
      }
    },
    removeTrack: (track: MediaStreamTrack) => {
      const index = tracks.indexOf(track);
      if (index >= 0) {
        tracks.splice(index, 1);
      }
    }
  } as MediaStream;
};

export const reconcileRemoteMediaBuckets = ({
  current,
  participant
}: {
  current: RemoteMediaState;
  participant: Pick<Participant, 'cameraStreamId' | 'screenStreamId'>;
}) => {
  const next: RemoteMediaState = pruneRemoteMediaState(current);

  if (participant.screenStreamId && next.cameraStream?.id === participant.screenStreamId) {
    next.screenStream = next.cameraStream;
    next.cameraStream = undefined;
  }

  if (participant.cameraStreamId && next.screenStream?.id === participant.cameraStreamId) {
    next.cameraStream = next.screenStream;
    next.screenStream = undefined;
  }

  if (
    next.cameraStream &&
    next.screenStream &&
    participant.cameraStreamId &&
    participant.screenStreamId &&
    next.cameraStream.id === next.screenStream.id
  ) {
    if (next.cameraStream.id === participant.screenStreamId) {
      next.cameraStream = undefined;
    } else if (next.screenStream.id === participant.cameraStreamId) {
      next.screenStream = undefined;
    }
  }

  return next;
};

const resolveRemoteBucket = ({
  current,
  participant,
  track,
  incomingStream
}: {
  current: RemoteMediaState;
  participant: Pick<
    Participant,
    'isCameraOn' | 'isMicOn' | 'isScreenSharing' | 'isSharingAudio' | 'cameraStreamId' | 'screenStreamId'
  >;
  track: MediaStreamTrack;
  incomingStream?: MediaStream;
}): RemoteBucket => {
  const streamId = incomingStream?.id;

  if (streamId && participant.screenStreamId === streamId) {
    return 'screenStream';
  }

  if (streamId && participant.cameraStreamId === streamId) {
    return 'cameraStream';
  }

  if (streamId && current.screenStream?.id === streamId) {
    return 'screenStream';
  }

  if (streamId && current.cameraStream?.id === streamId) {
    return 'cameraStream';
  }

  if (track.kind === 'video') {
    if (participant.isScreenSharing && !participant.isCameraOn) {
      return 'screenStream';
    }

    return 'cameraStream';
  }

  if (track.kind === 'audio') {
    if (participant.isMicOn && !participant.isSharingAudio) {
      return 'cameraStream';
    }

    if (!participant.isMicOn && participant.isSharingAudio) {
      return 'screenStream';
    }
  }

  if (!current.cameraStream) {
    return 'cameraStream';
  }

  if (!current.screenStream && participant.isScreenSharing) {
    return 'screenStream';
  }

  return 'cameraStream';
};

export const mergeIncomingRemoteTrack = ({
  current,
  participant,
  track,
  incomingStream
}: {
  current: RemoteMediaState;
  participant: Pick<
    Participant,
    | 'isCameraOn'
    | 'isMicOn'
    | 'isScreenSharing'
    | 'isSharingAudio'
    | 'cameraStreamId'
    | 'screenStreamId'
  >;
  track: MediaStreamTrack;
  incomingStream?: MediaStream;
}) => {
  const reconciled = reconcileRemoteMediaBuckets({ current: pruneRemoteMediaState(current), participant });
  const bucket = resolveRemoteBucket({
    current: reconciled,
    participant,
    track,
    incomingStream
  });
  const targetStream = incomingStream ?? reconciled[bucket] ?? createMutableMediaStream();

  // Keep a single active track per kind in each bucket to avoid stale ended tracks
  // masking missing media and preventing recovery.
  const existingSameKindTracks = targetStream
    .getTracks()
    .filter((existingTrack) => existingTrack.kind === track.kind && existingTrack.id !== track.id);
  for (const existingTrack of existingSameKindTracks) {
    targetStream.removeTrack(existingTrack);
  }

  if (!targetStream.getTracks().includes(track)) {
    targetStream.addTrack(track);
  }

  return reconcileRemoteMediaBuckets({
    current: {
      ...reconciled,
      [bucket]: targetStream
    },
    participant
  });
};
