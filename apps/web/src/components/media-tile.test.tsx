// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MediaTile } from './media-tile';
import type { Participant } from '../features/call/types';

const createStream = (withAudioTracks: number, withVideoTracks = 0) =>
  ({
    getAudioTracks: () => Array.from({ length: withAudioTracks }, () => ({ kind: 'audio' })),
    getVideoTracks: () => Array.from({ length: withVideoTracks }, () => ({ kind: 'video' }))
  }) as unknown as MediaStream;

const participantBase: Participant = {
  id: 'remote-1',
  displayName: 'Mira',
  role: 'participant',
  isCameraOn: false,
  isMicOn: true,
  isSpeaking: false,
  isScreenSharing: false,
  isSharingAudio: false,
  isPinned: false,
  connectionState: 'connected'
};

describe('MediaTile', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders a remote audio element when microphone is on and camera is off', () => {
    render(<MediaTile participant={participantBase} media={{ cameraStream: createStream(1) }} />);

    expect(screen.getByTestId('remote-camera-audio')).toBeTruthy();
  });

  it('applies a speaking class without requiring video', () => {
    render(<MediaTile participant={{ ...participantBase, isSpeaking: true }} media={{ cameraStream: createStream(1) }} />);

    expect(screen.getByTestId('media-tile').className).toContain('media-tile-speaking');
    expect(screen.getByTestId('media-tile').querySelector('[data-speaking-indicator="true"]')).toBeTruthy();
  });

  it('allows opening a tile in fullscreen mode by click', () => {
    const handleSelect = vi.fn();

    render(<MediaTile participant={participantBase} media={{ cameraStream: createStream(1) }} onSelect={handleSelect} />);    fireEvent.click(screen.getByRole('button', { name: /развернуть mira/i }));

    expect(handleSelect).toHaveBeenCalledWith('remote-1');
  });

  it('shows a camera-off placeholder label when no video is available', () => {
    render(<MediaTile participant={participantBase} />);

    expect(screen.getByText('M')).toBeTruthy();
  });

  it('renders remote video as soon as a camera track is available', () => {
    const { container } = render(
      <MediaTile participant={{ ...participantBase, isCameraOn: true }} media={{ cameraStream: createStream(1, 1) }} />
    );

    expect(container.querySelector('video')).toBeTruthy();
  });
});
