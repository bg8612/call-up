import { describe, expect, it } from 'vitest';
import {
  canApplyCandidateOrAnswer,
  hasLiveTrackByKind,
  isPeerOperationStale,
  mergeIncomingRemoteTrack,
  pruneRemoteMediaState,
  reconcileRemoteMediaBuckets,
  removeParticipantFromRemoteState,
  shouldScheduleMediaRecovery,
  shouldRunRecoveryTimer
} from './peer-stability';
import type { Participant, RemoteMediaState } from '../features/call/types';

const createTrack = (kind: 'audio' | 'video', id: string, readyState: MediaStreamTrackState = 'live') =>
  ({
    kind,
    id,
    readyState
  }) as MediaStreamTrack;

const createStream = (id: string, tracks: MediaStreamTrack[] = []) => {
  const ownedTracks = [...tracks];
  return {
    id,
    getTracks: () => [...ownedTracks],
    getAudioTracks: () => ownedTracks.filter((track) => track.kind === 'audio'),
    getVideoTracks: () => ownedTracks.filter((track) => track.kind === 'video'),
    addTrack: (track: MediaStreamTrack) => {
      if (!ownedTracks.includes(track)) {
        ownedTracks.push(track);
      }
    },
    removeTrack: (track: MediaStreamTrack) => {
      const index = ownedTracks.indexOf(track);
      if (index >= 0) {
        ownedTracks.splice(index, 1);
      }
    }
  } as unknown as MediaStream;
};

const participantBase: Participant = {
  id: 'p1',
  displayName: 'Mira',
  role: 'participant',
  isCameraOn: true,
  isMicOn: true,
  isSpeaking: false,
  isScreenSharing: false,
  isSharingAudio: false,
  isPinned: false,
  connectionState: 'connected',
  cameraStreamId: 'camera-1'
};

describe('peer stability guards', () => {
  it('ignores stale peer generation', () => {
    expect(
      isPeerOperationStale({
        currentVersion: 1,
        expectedVersion: 2,
        signalingState: 'stable'
      })
    ).toBe(true);
  });

  it('does not apply candidate/answer on closed peer', () => {
    expect(
      canApplyCandidateOrAnswer({
        signalingState: 'closed',
        currentVersion: 3,
        expectedVersion: 3
      })
    ).toBe(false);
  });

  it('ignores stale recovery timer callbacks', () => {
    expect(
      shouldRunRecoveryTimer({
        timerVersion: 4,
        currentVersion: 5
      })
    ).toBe(false);
    expect(
      shouldRunRecoveryTimer({
        timerVersion: 5,
        currentVersion: 5
      })
    ).toBe(true);
  });

  it('does not duplicate media recovery timers and schedules only when media is expected', () => {
    expect(
      shouldScheduleMediaRecovery({
        participantConnectionState: 'connected',
        isLocalParticipant: false,
        hasAnyExpectedMedia: true,
        alreadyScheduled: false,
        hasExpectedRemoteMedia: false
      })
    ).toBe(true);

    expect(
      shouldScheduleMediaRecovery({
        participantConnectionState: 'connected',
        isLocalParticipant: false,
        hasAnyExpectedMedia: true,
        alreadyScheduled: true,
        hasExpectedRemoteMedia: false
      })
    ).toBe(false);

    expect(
      shouldScheduleMediaRecovery({
        participantConnectionState: 'connected',
        isLocalParticipant: false,
        hasAnyExpectedMedia: true,
        alreadyScheduled: false,
        hasExpectedRemoteMedia: true
      })
    ).toBe(false);
  });

  it('removes participant remote media state on participant:left cleanup', () => {
    const before = new Map<string, { streamId: string }>([
      ['p1', { streamId: 's1' }],
      ['p2', { streamId: 's2' }]
    ]);

    const after = removeParticipantFromRemoteState(before, 'p1');
    expect(after.has('p1')).toBe(false);
    expect(after.has('p2')).toBe(true);
  });

  it('reconciles a screen stream that was initially bucketed as camera', () => {
    const screenStream = createStream('screen-1', [createTrack('video', 'screen-video-1')]);
    const current: RemoteMediaState = {
      cameraStream: screenStream
    };

    const reconciled = reconcileRemoteMediaBuckets({
      current,
      participant: {
        cameraStreamId: 'camera-1',
        screenStreamId: 'screen-1'
      }
    });

    expect(reconciled.cameraStream).toBeUndefined();
    expect(reconciled.screenStream).toBe(screenStream);
  });

  it('keeps audio when a remote track arrives without event.streams', () => {
    const audioTrack = createTrack('audio', 'audio-1');
    const current: RemoteMediaState = {};

    const next = mergeIncomingRemoteTrack({
      current,
      participant: participantBase,
      track: audioTrack
    });

    expect(next.cameraStream?.getAudioTracks()).toContain(audioTrack);
  });

  it('routes streamless screen audio into the screen bucket when mic is off', () => {
    const screenAudioTrack = createTrack('audio', 'screen-audio-1');

    const next = mergeIncomingRemoteTrack({
      current: {},
      participant: {
        ...participantBase,
        isMicOn: false,
        isScreenSharing: true,
        isSharingAudio: true,
        screenStreamId: 'screen-1'
      },
      track: screenAudioTrack
    });

    expect(next.screenStream?.getAudioTracks()).toContain(screenAudioTrack);
    expect(next.cameraStream).toBeUndefined();
  });

  it('preserves the incoming stream identity when a remote audio track includes a stream', () => {
    const audioTrack = createTrack('audio', 'audio-2');
    const incomingStream = createStream('camera-1', [audioTrack]);

    const next = mergeIncomingRemoteTrack({
      current: {},
      participant: participantBase,
      track: audioTrack,
      incomingStream
    });

    expect(next.cameraStream).toBe(incomingStream);
  });

  it('treats only live tracks as satisfied remote media', () => {
    const endedAudio = createTrack('audio', 'ended-audio', 'ended');
    const liveAudio = createTrack('audio', 'live-audio', 'live');
    const streamWithEndedTrack = createStream('camera-1', [endedAudio]);
    const streamWithLiveTrack = createStream('camera-2', [liveAudio]);

    expect(hasLiveTrackByKind(streamWithEndedTrack, 'audio')).toBe(false);
    expect(hasLiveTrackByKind(streamWithLiveTrack, 'audio')).toBe(true);
  });

  it('prunes ended tracks from remote media state', () => {
    const endedAudio = createTrack('audio', 'ended-audio', 'ended');
    const liveVideo = createTrack('video', 'live-video', 'live');
    const cameraStream = createStream('camera-1', [endedAudio]);
    const screenStream = createStream('screen-1', [liveVideo]);

    const pruned = pruneRemoteMediaState({
      cameraStream,
      screenStream
    });

    expect(pruned.cameraStream).toBeUndefined();
    expect(pruned.screenStream).toBe(screenStream);
  });

  it('replaces stale same-kind tracks inside the resolved bucket', () => {
    const oldAudio = createTrack('audio', 'audio-old');
    const newAudio = createTrack('audio', 'audio-new');
    const cameraStream = createStream('camera-1', [oldAudio]);

    const next = mergeIncomingRemoteTrack({
      current: { cameraStream },
      participant: participantBase,
      track: newAudio
    });

    expect(next.cameraStream?.getAudioTracks()).toEqual([newAudio]);
  });
});
