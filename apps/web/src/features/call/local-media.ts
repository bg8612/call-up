type StreamLike = Pick<MediaStream, 'getTracks' | 'getAudioTracks' | 'getVideoTracks' | 'addTrack' | 'removeTrack'>;

const createEmptyMediaStream = (): MediaStream => {
  if (typeof MediaStream !== 'undefined') {
    return new MediaStream();
  }

  const tracks: MediaStreamTrack[] = [];
  const shim: StreamLike = {
    getTracks: () => [...tracks],
    getAudioTracks: () => tracks.filter((track) => track.kind === 'audio'),
    getVideoTracks: () => tracks.filter((track) => track.kind === 'video'),
    addTrack: (track) => {
      if (!tracks.includes(track)) {
        tracks.push(track);
      }
    },
    removeTrack: (track) => {
      const index = tracks.indexOf(track);
      if (index >= 0) {
        tracks.splice(index, 1);
      }
    }
  };

  return shim as MediaStream;
};

const getTracksByKind = (stream: MediaStream, kind: 'audio' | 'video') =>
  kind === 'audio' ? stream.getAudioTracks() : stream.getVideoTracks();

export const ensureMediaStream = (stream: MediaStream | null) => stream ?? createEmptyMediaStream();

export const getTrackByKind = (stream: MediaStream | null, kind: 'audio' | 'video') =>
  stream ? getTracksByKind(stream, kind)[0] ?? null : null;

export const replaceTrackInStream = (
  current: MediaStream | null,
  kind: 'audio' | 'video',
  track: MediaStreamTrack
) => {
  const stream = ensureMediaStream(current);
  const existing = getTrackByKind(stream, kind);

  if (existing && existing !== track) {
    stream.removeTrack(existing);
    existing.stop();
  }

  if (!stream.getTracks().includes(track)) {
    stream.addTrack(track);
  }

  return stream;
};

export const removeTrackFromStream = (current: MediaStream | null, kind: 'audio' | 'video') => {
  if (!current) {
    return null;
  }

  const existing = getTrackByKind(current, kind);
  if (!existing) {
    return current;
  }

  current.removeTrack(existing);
  existing.stop();

  return current.getTracks().length > 0 ? current : null;
};

export const setTrackEnabled = (stream: MediaStream | null, kind: 'audio' | 'video', enabled: boolean) => {
  const track = getTrackByKind(stream, kind);
  if (track) {
    track.enabled = enabled;
  }

  return track;
};
