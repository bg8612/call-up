import { describe, expect, it } from 'vitest';
import {
  ensureMediaStream,
  getTrackByKind,
  removeTrackFromStream,
  replaceTrackInStream,
  setTrackEnabled
} from './local-media';

const createTrack = (kind: 'audio' | 'video', label: string) => {
  let enabled = true;
  let stopped = false;

  return {
    kind,
    id: label,
    get enabled() {
      return enabled;
    },
    set enabled(value: boolean) {
      enabled = value;
    },
    stop() {
      stopped = true;
    },
    get stopped() {
      return stopped;
    }
  } as unknown as MediaStreamTrack;
};

describe('local-media', () => {
  it('keeps audio track when replacing video track', () => {
    const audio = createTrack('audio', 'mic-1');
    const video = createTrack('video', 'cam-1');
    const nextVideo = createTrack('video', 'cam-2');

    let stream = replaceTrackInStream(null, 'audio', audio);
    stream = replaceTrackInStream(stream, 'video', video);
    stream = replaceTrackInStream(stream, 'video', nextVideo);

    expect(getTrackByKind(stream, 'audio')).toBe(audio);
    expect(getTrackByKind(stream, 'video')).toBe(nextVideo);
  });

  it('creates stream on demand and can disable existing track', () => {
    const audio = createTrack('audio', 'mic-1');
    const stream = replaceTrackInStream(ensureMediaStream(null), 'audio', audio)!;

    setTrackEnabled(stream, 'audio', false);

    expect(getTrackByKind(stream, 'audio')?.enabled).toBe(false);
  });

  it('removes only the selected kind from a mixed stream', () => {
    const audio = createTrack('audio', 'mic-1');
    const video = createTrack('video', 'cam-1');

    let stream = replaceTrackInStream(null, 'audio', audio);
    stream = replaceTrackInStream(stream, 'video', video);
    stream = removeTrackFromStream(stream, 'video')!;

    expect(getTrackByKind(stream, 'audio')).toBe(audio);
    expect(getTrackByKind(stream, 'video')).toBeNull();
  });
});
