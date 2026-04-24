import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MediaTile } from './media-tile';
import type { Participant } from '../features/call/types';

const createStream = (withAudioTracks: number) =>
  ({
    getAudioTracks: () => Array.from({ length: withAudioTracks }, () => ({ kind: 'audio' }))
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
  it('renders a remote audio element when microphone is on and camera is off', () => {
    render(
      <MediaTile
        participant={participantBase}
        media={{ cameraStream: createStream(1) }}
        onPin={() => {}}
      />
    );

    expect(screen.getByTestId('remote-camera-audio')).toBeInTheDocument();
  });

  it('applies a speaking class without requiring video', () => {
    render(
      <MediaTile
        participant={{ ...participantBase, isSpeaking: true }}
        media={{ cameraStream: createStream(1) }}
        onPin={() => {}}
      />
    );

    expect(screen.getByTestId('media-tile')).toHaveClass('media-tile-speaking');
  });

  it('exposes an accessible pin toggle button', () => {
    render(<MediaTile participant={participantBase} media={{ cameraStream: createStream(1) }} onPin={() => {}} />);

    expect(screen.getByRole('button', { name: /pin mira/i })).toBeInTheDocument();
  });

  it('shows a camera-off placeholder label when no video is available', () => {
    render(<MediaTile participant={participantBase} onPin={() => {}} />);

    expect(screen.getByText(/video is currently unavailable/i)).toBeInTheDocument();
  });
});
