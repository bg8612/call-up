import { useEffect, useRef } from 'react';
import { Mic, MicOff, MonitorUp, Pin, PinOff, Video, VideoOff, Volume2 } from 'lucide-react';
import type { Participant, RemoteMediaState } from '../features/call/types';
import { Avatar, AvatarFallback } from './ui/avatar';
import { Button } from './ui/button';
import { cn } from '../lib/cn';

type MediaTileProps = {
  participant: Participant;
  media?: RemoteMediaState;
  isLocal?: boolean;
  onPin: (participantId: string | null) => void;
  className?: string;
};

const streamHasAudio = (stream?: MediaStream) => Boolean(stream?.getAudioTracks().length);

export const MediaTile = ({ participant, media, isLocal, onPin, className }: MediaTileProps) => {
  const cameraRef = useRef<HTMLVideoElement | null>(null);
  const screenRef = useRef<HTMLVideoElement | null>(null);
  const cameraAudioRef = useRef<HTMLAudioElement | null>(null);
  const screenAudioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    if (cameraRef.current && media?.cameraStream) {
      cameraRef.current.srcObject = media.cameraStream;
    }
  }, [media?.cameraStream]);

  useEffect(() => {
    if (screenRef.current && media?.screenStream) {
      screenRef.current.srcObject = media.screenStream;
    }
  }, [media?.screenStream]);

  useEffect(() => {
    if (cameraAudioRef.current && media?.cameraStream) {
      cameraAudioRef.current.srcObject = media.cameraStream;
    }
  }, [media?.cameraStream]);

  useEffect(() => {
    if (screenAudioRef.current && media?.screenStream) {
      screenAudioRef.current.srcObject = media.screenStream;
    }
  }, [media?.screenStream]);

  const statusChips = [
    {
      key: 'mic',
      label: participant.isMicOn ? 'Mic on' : 'Mic muted',
      icon: participant.isMicOn ? Mic : MicOff
    },
    {
      key: 'camera',
      label: participant.isCameraOn ? 'Camera on' : 'Camera off',
      icon: participant.isCameraOn ? Video : VideoOff
    }
  ];

  return (
    <article
      data-testid="media-tile"
      className={cn(
        'group relative flex min-h-[220px] flex-col overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--surface-muted)]',
        participant.isSpeaking && 'media-tile-speaking',
        className
      )}
    >
      <div
        data-speaking-indicator={participant.isSpeaking ? 'true' : 'false'}
        className="h-0.5 w-full bg-[var(--accent)] opacity-0 transition-opacity duration-200 ease-out"
      />

      <div className="flex items-center justify-between gap-3 border-b border-[var(--border)] px-3 py-3">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium text-[var(--text-primary)]">{participant.displayName}</div>
          <div className="mt-1 flex items-center gap-2 text-xs text-[var(--text-secondary)]">
            <span>{participant.role === 'owner' ? 'Owner' : 'Participant'}</span>
            {isLocal ? <span>You</span> : null}
            {participant.connectionState === 'reconnecting' ? <span>Reconnecting</span> : null}
          </div>
        </div>

        <Button
          variant={participant.isPinned ? 'accent' : 'ghost'}
          size="sm"
          aria-label={participant.isPinned ? `Unpin ${participant.displayName}` : `Pin ${participant.displayName}`}
          onClick={() => onPin(participant.isPinned ? null : participant.id)}
        >
          {participant.isPinned ? <PinOff className="size-4" /> : <Pin className="size-4" />}
          <span>{participant.isPinned ? 'Unpin' : 'Pin'}</span>
        </Button>
      </div>

      <div className="relative flex flex-1 items-center justify-center bg-[var(--surface-contrast)]">
        {participant.isScreenSharing && media?.screenStream ? (
          <video ref={screenRef} autoPlay playsInline muted className="h-full w-full object-contain" />
        ) : participant.isCameraOn && media?.cameraStream ? (
          <video ref={cameraRef} autoPlay playsInline muted className="h-full w-full object-cover" />
        ) : (
          <div className="flex flex-col items-center justify-center gap-4 px-6 text-center">
            <Avatar className="size-20 border-[var(--border-strong)] bg-[var(--surface)] text-2xl">
              <AvatarFallback>{participant.displayName.slice(0, 1).toUpperCase()}</AvatarFallback>
            </Avatar>
            <div>
              <div className="text-sm font-medium text-[var(--text-primary)]">Camera off</div>
              <p className="mt-1 text-sm text-[var(--text-secondary)]">
                {participant.isSpeaking ? 'Speaking now' : isLocal ? 'You are visible to the room once camera turns on.' : 'Video is currently unavailable.'}
              </p>
            </div>
          </div>
        )}

        <div className="absolute bottom-3 left-3 right-3 flex items-end justify-between gap-3">
          <div className="rounded-md border border-[var(--border)] bg-[rgba(9,11,16,0.88)] px-3 py-2">
            <div className="text-sm font-medium text-[var(--text-primary)]">{participant.displayName}</div>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-[var(--text-secondary)]">
              {participant.isScreenSharing ? (
                <span className="inline-flex items-center gap-1 text-[var(--warning)]">
                  <MonitorUp className="size-3.5" />
                  Sharing screen
                </span>
              ) : null}
              {participant.isSpeaking ? (
                <span className="inline-flex items-center gap-1 text-[var(--accent)]">
                  <Volume2 className="size-3.5" />
                  Speaking
                </span>
              ) : null}
            </div>
          </div>
        </div>
      </div>

      {streamHasAudio(media?.cameraStream) ? (
        <audio
          ref={cameraAudioRef}
          autoPlay
          playsInline
          muted={Boolean(isLocal)}
          data-testid="remote-camera-audio"
          className="sr-only"
        />
      ) : null}

      {streamHasAudio(media?.screenStream) ? (
        <audio
          ref={screenAudioRef}
          autoPlay
          playsInline
          muted={Boolean(isLocal)}
          data-testid="remote-screen-audio"
          className="sr-only"
        />
      ) : null}

      <div className="flex flex-wrap items-center gap-2 border-t border-[var(--border)] px-3 py-3">
        {statusChips.map(({ key, label, icon: Icon }) => (
          <span
            key={key}
            className="inline-flex items-center gap-1.5 rounded-md border border-[var(--border)] bg-[var(--surface)] px-2.5 py-1 text-xs text-[var(--text-secondary)]"
          >
            <Icon className="size-3.5" />
            {label}
          </span>
        ))}
        {participant.isScreenSharing ? (
          <span className="inline-flex items-center gap-1.5 rounded-md border border-[var(--border)] bg-[var(--surface)] px-2.5 py-1 text-xs text-[var(--warning)]">
            <MonitorUp className="size-3.5" />
            Screen live
          </span>
        ) : null}
      </div>
    </article>
  );
};
