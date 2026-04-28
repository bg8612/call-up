import { useCallback, useEffect, useRef, type KeyboardEvent } from 'react';
import { Maximize2, MicOff, MonitorUp, Volume2 } from 'lucide-react';
import type { AudioOutputMediaElement, Participant, RemoteMediaState } from '../features/call/types';
import { Avatar, AvatarFallback } from './ui/avatar';
import { cn } from '../lib/cn';

type MediaTileProps = {
  participant: Participant;
  media?: RemoteMediaState;
  isLocal?: boolean;
  isFullscreen?: boolean;
  onSelect?: (participantId: string) => void;
  showSelectHint?: boolean;
  className?: string;
  audioOutputDeviceId?: string;
  cardColor?: string;
};

const streamHasAudio = (stream?: MediaStream) => Boolean(stream?.getAudioTracks().length);
const streamHasVideo = (stream?: MediaStream) => Boolean(stream?.getVideoTracks().length);

export const MediaTile = ({
  participant,
  media,
  isLocal,
  isFullscreen = false,
  onSelect,
  showSelectHint = true,
  className,
  audioOutputDeviceId,
  cardColor
}: MediaTileProps) => {
  const cameraRef = useRef<HTMLVideoElement | null>(null);
  const screenRef = useRef<HTMLVideoElement | null>(null);
  const cameraAudioRef = useRef<HTMLAudioElement | null>(null);
  const screenAudioRef = useRef<HTMLAudioElement | null>(null);
  const hasCameraVideo = streamHasVideo(media?.cameraStream);
  const hasScreenVideo = streamHasVideo(media?.screenStream);
  const hasStatusRow =
    participant.connectionState === 'reconnecting' ||
    participant.isScreenSharing ||
    participant.isSpeaking;

  const bindMediaStream = useCallback((element: HTMLMediaElement | null, stream?: MediaStream) => {
    if (!element) {
      return;
    }

    const nextStream = stream ?? null;
    if (element.srcObject !== nextStream) {
      element.srcObject = nextStream;
    }
  }, []);

  const setCameraVideoRef = useCallback(
    (element: HTMLVideoElement | null) => {
      cameraRef.current = element;
      bindMediaStream(element, media?.cameraStream);
    },
    [bindMediaStream, media?.cameraStream]
  );

  const setScreenVideoRef = useCallback(
    (element: HTMLVideoElement | null) => {
      screenRef.current = element;
      bindMediaStream(element, media?.screenStream);
    },
    [bindMediaStream, media?.screenStream]
  );

  const setCameraAudioElementRef = useCallback(
    (element: HTMLAudioElement | null) => {
      cameraAudioRef.current = element;
      bindMediaStream(element, media?.cameraStream);
    },
    [bindMediaStream, media?.cameraStream]
  );

  const setScreenAudioElementRef = useCallback(
    (element: HTMLAudioElement | null) => {
      screenAudioRef.current = element;
      bindMediaStream(element, media?.screenStream);
    },
    [bindMediaStream, media?.screenStream]
  );

  useEffect(() => {
    bindMediaStream(cameraRef.current, media?.cameraStream);
  }, [bindMediaStream, hasCameraVideo, media?.cameraStream, participant.isCameraOn]);

  useEffect(() => {
    bindMediaStream(screenRef.current, media?.screenStream);
  }, [bindMediaStream, hasScreenVideo, media?.screenStream, participant.isScreenSharing]);

  useEffect(() => {
    bindMediaStream(cameraAudioRef.current, media?.cameraStream);
  }, [bindMediaStream, media?.cameraStream, participant.isMicOn]);

  useEffect(() => {
    bindMediaStream(screenAudioRef.current, media?.screenStream);
  }, [bindMediaStream, media?.screenStream, participant.isSharingAudio]);

  useEffect(() => {
    const applySinkId = async (element: AudioOutputMediaElement | null) => {
      if (!element || !audioOutputDeviceId || isLocal || typeof element.setSinkId !== 'function') {
        return;
      }

      try {
        await element.setSinkId(audioOutputDeviceId);
      } catch (error) {
        console.warn('Failed to switch audio output device', error);
      }
    };

    void applySinkId(cameraAudioRef.current as AudioOutputMediaElement | null);
    void applySinkId(screenAudioRef.current as AudioOutputMediaElement | null);
  }, [audioOutputDeviceId, isLocal, media?.cameraStream, media?.screenStream]);

  const handleSelect = () => {
    onSelect?.(participant.id);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (!onSelect) {
      return;
    }

    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      handleSelect();
    }
  };

  return (
    <article
      data-testid="media-tile"
      role={onSelect ? 'button' : undefined}
      tabIndex={onSelect ? 0 : undefined}
      aria-label={onSelect ? `${isFullscreen ? 'Свернуть' : 'Развернуть'} ${participant.displayName}` : undefined}
      onClick={onSelect ? handleSelect : undefined}
      onKeyDown={handleKeyDown}
      className={cn(
        'group relative h-full w-full min-h-0 overflow-hidden rounded-[18px] transition-transform duration-200 ease-out',
        onSelect && 'cursor-pointer',
        participant.isSpeaking && 'media-tile-speaking',
        className
      )}
      style={{ backgroundColor: cardColor ?? '#15171c' }}
    >
      <div
        aria-hidden="true"
        data-speaking-indicator={participant.isSpeaking ? 'true' : 'false'}
        className="pointer-events-none absolute inset-0 z-10 rounded-[18px] opacity-0 transition duration-150 ease-out"
      />

      <div className="absolute inset-0">
        {participant.isScreenSharing && hasScreenVideo ? (
          <video ref={setScreenVideoRef} autoPlay playsInline muted className="h-full w-full bg-[#0b0d12] object-contain" />
        ) : participant.isCameraOn && hasCameraVideo ? (
          <video ref={setCameraVideoRef} autoPlay playsInline muted className="h-full w-full bg-[#0b0d12] object-contain" />
        ) : (
          <div className="flex h-full w-full items-center justify-center" style={{ backgroundColor: cardColor ?? '#2a2426' }}>
            <div className="flex flex-col items-center justify-center gap-4 px-6 text-center">
              <Avatar className="size-20 border-0 bg-[#e7eaee] text-2xl text-[#17181c]">
                <AvatarFallback>{participant.displayName.slice(0, 1).toUpperCase()}</AvatarFallback>
              </Avatar>
            </div>
          </div>
        )}
      </div>

      {onSelect && showSelectHint ? (
        <div className="pointer-events-none absolute right-3 top-3 opacity-0 transition-opacity duration-200 ease-out group-hover:opacity-100">
          <span className="inline-flex size-8 items-center justify-center rounded-full bg-[rgba(17,18,20,0.74)] text-white backdrop-blur-sm">
            <Maximize2 className="size-4" />
          </span>
        </div>
      ) : null}

      <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-end justify-between gap-3 p-3">
        <div className="flex min-w-0 flex-col items-center justify-center rounded-xl bg-[rgba(17,18,20,0.72)] px-3 py-2 text-center backdrop-blur-sm">
          <div className="truncate text-center text-sm font-semibold text-white">
            {participant.displayName}
            {isLocal ? ' (Вы)' : ''}
          </div>
          {hasStatusRow ? (
            <div className="mt-1 flex flex-wrap items-center justify-center gap-2 text-[11px] text-[#c6ccd6]">
              {participant.connectionState === 'reconnecting' ? (
                <span className="inline-flex items-center gap-1 text-[#f0c36e]">
                  <span className="size-1.5 rounded-full bg-current" />
                  Переподключение
                </span>
              ) : null}
              {participant.isScreenSharing ? (
                <span className="inline-flex items-center gap-1 text-[#f0c36e]">
                  <MonitorUp className="size-3.5" />
                  Экран
                </span>
              ) : null}
              {participant.isSpeaking ? (
                <span className="inline-flex items-center gap-1 text-[#89a7ff]">
                  <Volume2 className="size-3.5" />
                  Говорит
                </span>
              ) : null}
            </div>
          ) : null}
        </div>

        {!participant.isMicOn ? (
          <span className="inline-flex size-9 shrink-0 items-center justify-center rounded-full bg-[rgba(17,18,20,0.72)] text-[#d7dce4] backdrop-blur-sm">
            <MicOff className="size-4.5" />
          </span>
        ) : null}
      </div>

      {streamHasAudio(media?.cameraStream) ? (
        <audio
          ref={setCameraAudioElementRef}
          autoPlay
          playsInline
          muted={Boolean(isLocal)}
          data-testid="remote-camera-audio"
          className="sr-only"
        />
      ) : null}

      {streamHasAudio(media?.screenStream) ? (
        <audio
          ref={setScreenAudioElementRef}
          autoPlay
          playsInline
          muted={Boolean(isLocal)}
          data-testid="remote-screen-audio"
          className="sr-only"
        />
      ) : null}
    </article>
  );
};


