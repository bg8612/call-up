import { useEffect, useMemo, useRef, useState, type ComponentPropsWithoutRef, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { ArrowUp, Camera, CameraOff, Check, ChevronDown, Copy, LogOut, Mic, MicOff, MonitorUp, PanelRight, X } from 'lucide-react';
import { useCallRoom } from './hooks/use-call-room';
import type { ChatMessage, Participant, RemoteMediaState } from './features/call/types';
import { buildInviteLink, readPrefilledRoomId } from './features/invite/invite-link';
import { MediaTile } from './components/media-tile';
import { getVideoGridLayout } from './components/video-grid-layout';
import { Avatar, AvatarFallback } from './components/ui/avatar';
import { Button } from './components/ui/button';
import { Input } from './components/ui/input';
import { ScrollArea } from './components/ui/scroll-area';
import { Tabs, TabsContent, TabsList, TabsTrigger } from './components/ui/tabs';
import { Textarea } from './components/ui/textarea';
import { cn } from './lib/cn';

const MAX_ROOM_ID_LENGTH = 8;
const ROOM_SESSION_STORAGE_KEY = 'callup:room-session';
const USER_CARD_PASTELS = [
  '#3f2c35',
  '#2f3f60',
  '#2e4b47',
  '#4c3748',
  '#3b3f63',
  '#3e4c34',
  '#4f3241',
  '#2f4b59',
  '#4c3d2b',
  '#3a3153',
  '#2d4d3f',
  '#4c3030',
  '#2f365a',
  '#40314c',
  '#325060',
  '#4d3c54'
];

type ViewportLayout = {
  height: number;
  topInset: number;
  bottomInset: number;
};
const getViewportLayout = (): ViewportLayout => {
  if (typeof window === 'undefined') {
    return {
      height: 0,
      topInset: 0,
      bottomInset: 0
    };
  }
  const viewport = window.visualViewport;
  if (!viewport) {
    return {
      height: window.innerHeight,
      topInset: 0,
      bottomInset: 0
    };
  }
  const topInset = Math.max(0, Math.round(viewport.offsetTop));
  const height = Math.max(0, Math.round(viewport.height));
  const bottomInset = Math.max(0, Math.round(window.innerHeight - viewport.height - viewport.offsetTop));
  return {
    height,
    topInset,
    bottomInset
  };
};

type StoredRoomSession = {
  roomId: string;
  displayName: string;
  clientSessionId: string;
};

const normalizeRoomId = (value: string) => value.trim().slice(0, MAX_ROOM_ID_LENGTH);

const buildGeneratedPastel = (seed: number) => {
  const hue = (seed * 47) % 360;
  const saturation = 34 + (seed % 4) * 3;
  const lightness = 22 + (seed % 3) * 2;
  return `hsl(${hue} ${saturation}% ${lightness}%)`;
};

const generateClientSessionId = () => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }

  return `client_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
};

const readStoredRoomSession = (): StoredRoomSession | null => {
  if (typeof window === 'undefined') {
    return null;
  }

  try {
    const rawValue = window.sessionStorage.getItem(ROOM_SESSION_STORAGE_KEY);
    if (!rawValue) {
      return null;
    }

    const parsed = JSON.parse(rawValue) as Partial<StoredRoomSession>;
    const roomId = normalizeRoomId(String(parsed.roomId ?? ''));
    const displayName = String(parsed.displayName ?? '').trim();
    const clientSessionId = String(parsed.clientSessionId ?? '').trim() || generateClientSessionId();

    if (!roomId || !displayName) {
      return null;
    }

    return { roomId, displayName, clientSessionId };
  } catch {
    return null;
  }
};

const storeRoomSession = (session: StoredRoomSession) => {
  if (typeof window === 'undefined') {
    return;
  }

  window.sessionStorage.setItem(ROOM_SESSION_STORAGE_KEY, JSON.stringify(session));
};

const clearStoredRoomSession = () => {
  if (typeof window === 'undefined') {
    return;
  }

  window.sessionStorage.removeItem(ROOM_SESSION_STORAGE_KEY);
};

const readInitialStoredRoomSession = (invitedRoomId: string): StoredRoomSession | null => {
  const storedSession = readStoredRoomSession();
  if (!storedSession) {
    return null;
  }

  if (invitedRoomId && storedSession.roomId !== invitedRoomId) {
    clearStoredRoomSession();
    return null;
  }

  return storedSession;
};

const generateRoomId = () => {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < MAX_ROOM_ID_LENGTH; i += 1) {
    result += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return result;
};

const RoomIdGeneratorIcon = (props: ComponentPropsWithoutRef<'svg'>) => (
  <svg
    width="100%"
    height="100%"
    viewBox="0 0 24 24"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    aria-hidden="true"
    {...props}
  >
    <path
      d="M2 10C2 10 2.12132 9.15076 5.63604 5.63604C9.15076 2.12132 14.8492 2.12132 18.364 5.63604C19.6092 6.88131 20.4133 8.40072 20.7762 10M2 10V4M2 10H8M22 14C22 14 21.8787 14.8492 18.364 18.364C14.8492 21.8787 9.15076 21.8787 5.63604 18.364C4.39076 17.1187 3.58669 15.5993 3.22383 14M22 14V20M22 14H16"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

const JoinView = ({
  onJoin,
  errorMessage,
  isJoining,
  initialRoomId
}: {
  onJoin: (formData: FormData) => void;
  errorMessage: string | null;
  isJoining: boolean;
  initialRoomId: string;
}) => {
  const [roomId, setRoomId] = useState(initialRoomId);

  useEffect(() => {
    setRoomId(initialRoomId);
  }, [initialRoomId]);

  return (
    <main className="min-h-screen bg-[var(--background)] px-4 py-6 text-[var(--text-primary)] sm:px-6 lg:px-8">
      <div className="mx-auto flex min-h-[calc(100vh-3rem)] max-w-[420px] items-center justify-center">
        <section className="w-full rounded-2xl border border-[var(--border)] p-6 sm:p-8">
          <div className="mb-6">
            <h2 className="text-2xl font-semibold">Войти в звонок</h2>
          </div>

          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              onJoin(new FormData(event.currentTarget));
            }}
          >
            <label className="grid gap-2">
              <span className="text-sm text-[var(--text-secondary)]">Ваше имя</span>
              <Input name="displayName" placeholder="Александр" required />
            </label>
            <label className="grid gap-2">
              <span className="text-sm text-[var(--text-secondary)]">Идентификатор комнаты</span>
              
              <div className="flex gap-2">
                <Input
                  name="roomId"
                  placeholder="teamsync"
                  required
                  value={roomId}
                  maxLength={MAX_ROOM_ID_LENGTH}
                  onChange={(event) => setRoomId(normalizeRoomId(event.target.value))}
                />
                <Button
                  size="icon"
                  variant="secondary"
                  aria-label="Generate room id"
                  onClick={() => setRoomId(generateRoomId())}
                >
                  <RoomIdGeneratorIcon className="size-5" />
                </Button>
              </div>
            </label>
            <Button type="submit" variant="accent" className="w-full" disabled={isJoining}>
              {isJoining ? 'Подключение...' : 'Войти в комнату'}
            </Button>
          </form>

          {errorMessage ? (
            <div className="mt-4 rounded-2xl border border-[var(--danger-border)] bg-[var(--danger-soft)] px-4 py-3 text-sm text-[var(--danger-foreground)]">
              {errorMessage}
            </div>
          ) : null}
        </section>
      </div>
    </main>
  );
};

const statusTone = (message: ChatMessage) =>
  message.kind === 'system'
    ? 'border-[var(--border)] text-[var(--text-secondary)]'
    : 'border-[var(--border)] text-[var(--text-primary)]';

function App() {
  const initialInvitedRoomId = normalizeRoomId(readPrefilledRoomId(window.location.href));
  const [copiedInvite, setCopiedInvite] = useState<string | null>(null);
  const [prefilledRoomId, setPrefilledRoomId] = useState(initialInvitedRoomId);
  const [savedSession, setSavedSession] = useState<StoredRoomSession | null>(() =>
    readInitialStoredRoomSession(initialInvitedRoomId)
  );
  const [fullscreenParticipantId, setFullscreenParticipantId] = useState<string | null>(null);
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const autoRejoinAttemptedRef = useRef(false);
  const participantCardColorsRef = useRef<Map<string, string>>(new Map());
  const {
    joinState,
    errorMessage,
    callState,
    localParticipant,
    localParticipantId,
    localCameraStream,
    localScreenStream,
    remoteStreams,
    devices,
    selectedAudioInputId,
    selectedAudioOutputId,
    selectedVideoInputId,
    pendingMessage,
    activePanel,
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
    applyAudioInput,
    applyAudioOutput,
    applyVideoInput
  } = useCallRoom();

  const copyInviteLink = async (roomId: string) => {
    const normalizedRoomId = normalizeRoomId(roomId);
    const inviteLink = buildInviteLink(window.location.origin + window.location.pathname, normalizedRoomId);
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(inviteLink);
    } else {
      const textArea = document.createElement('textarea');
      textArea.value = inviteLink;
      document.body.appendChild(textArea);
      textArea.select();
      document.execCommand('copy');
      textArea.remove();
    }

    setCopiedInvite(inviteLink);
    window.history.replaceState({}, '', `?room=${encodeURIComponent(normalizedRoomId)}`);
    setPrefilledRoomId(normalizedRoomId);
  };

  const currentRoomId = normalizeRoomId(prefilledRoomId || readPrefilledRoomId(window.location.href) || 'teamsync');
  const participants = callState.participants;
  const participantCardColors = useMemo(() => {
    const previousColors = participantCardColorsRef.current;
    const nextColors = new Map<string, string>();
    const usedColors = new Set<string>();
    const palettePool = [...USER_CARD_PASTELS];
    let generatedSeed = participants.length;

    const takeNextAvailableColor = () => {
      while (palettePool.length) {
        const candidate = palettePool.shift()!;
        if (!usedColors.has(candidate)) {
          return candidate;
        }
      }

      while (true) {
        const generated = buildGeneratedPastel(generatedSeed);
        generatedSeed += 1;
        if (!usedColors.has(generated)) {
          return generated;
        }
      }
    };

    participants.forEach((participant) => {
      const existingColor = previousColors.get(participant.id);
      if (existingColor && !usedColors.has(existingColor)) {
        nextColors.set(participant.id, existingColor);
        usedColors.add(existingColor);
      }
    });

    participants.forEach((participant) => {
      if (nextColors.has(participant.id)) {
        return;
      }

      const nextColor = takeNextAvailableColor();
      nextColors.set(participant.id, nextColor);
      usedColors.add(nextColor);
    });

    participantCardColorsRef.current = nextColors;
    return nextColors;
  }, [participants]);
  const canPinTiles = participants.length > 1;
  const localMedia: RemoteMediaState = {
    cameraStream: localCameraStream ?? undefined,
    screenStream: localScreenStream ?? undefined
  };
  const isScreenSharing = Boolean(localParticipant?.isScreenSharing || localScreenStream);
  const showOwnerActions = localParticipant?.role === 'owner';

  const fullscreenParticipant = useMemo(
    () => participants.find((participant) => participant.id === fullscreenParticipantId) ?? null,
    [fullscreenParticipantId, participants]
  );

  const galleryParticipants = fullscreenParticipant
    ? participants.filter((participant) => participant.id !== fullscreenParticipant.id)
    : participants;

  const shouldShowGalleryRail = Boolean(fullscreenParticipant) && galleryParticipants.length > 5;
  const showGalleryRail = shouldShowGalleryRail && !isSidebarOpen;
  const gridParticipants = fullscreenParticipant ? (showGalleryRail ? [] : galleryParticipants) : galleryParticipants;
  const layoutNeedsRightPadding = isSidebarOpen || showGalleryRail;

  const fullscreenMedia = fullscreenParticipant
    ? fullscreenParticipant.id === localParticipantId
      ? localMedia
      : remoteStreams.get(fullscreenParticipant.id)
    : undefined;

  const galleryLayout = getVideoGridLayout(gridParticipants.length, {
    condensed: Boolean(fullscreenParticipant)
  });
  const visibleChatMessages = callState.chatMessages.filter((message) => message.kind !== 'system');

  useEffect(() => {
    if (fullscreenParticipantId && !participants.some((participant) => participant.id === fullscreenParticipantId)) {
      setFullscreenParticipantId(null);
    }
  }, [fullscreenParticipantId, participants]);

  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsSidebarOpen(false);
      }
    };

    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, []);

  const toggleFullscreenParticipant = (participantId: string) => {
    if (!canPinTiles && participantId === localParticipantId) {
      return;
    }
    setFullscreenParticipantId((current) => (current === participantId ? null : participantId));
  };

  const handleChatInputKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' || event.shiftKey) {
      return;
    }

    event.preventDefault();
    void sendChatMessage();
  };

  useEffect(() => {
    if (!savedSession) {
      return;
    }

    storeRoomSession(savedSession);
  }, [savedSession]);

  useEffect(() => {
    if (joinState !== 'idle' || autoRejoinAttemptedRef.current || !savedSession) {
      return;
    }

    autoRejoinAttemptedRef.current = true;
    setPrefilledRoomId(savedSession.roomId);
    window.history.replaceState({}, '', `?room=${encodeURIComponent(savedSession.roomId)}`);
    void joinRoom(savedSession);
  }, [joinRoom, joinState, savedSession]);

  const handleLeaveRoom = () => {
    clearStoredRoomSession();
    setSavedSession(null);
    leaveRoom();
  };

  const isRestoringSavedSession =
    Boolean(savedSession) && (joinState === 'idle' || (joinState === 'joining' && autoRejoinAttemptedRef.current));

  if (isRestoringSavedSession) {
    return (
      <main className="app-shell overflow-hidden bg-[var(--background)] px-3 text-[var(--text-primary)] sm:px-4">
        <div className="flex h-full items-center justify-center rounded-2xl border border-[var(--border)] bg-[var(--surface)]">
          <div className="text-sm text-[var(--text-secondary)]">Возвращаем в комнату…</div>
        </div>
      </main>
    );
  }

  if (joinState !== 'joined') {
    return (
      <JoinView
        isJoining={joinState === 'joining'}
        errorMessage={errorMessage}
        initialRoomId={currentRoomId}
        onJoin={(formData) => {
          const roomId = normalizeRoomId(String(formData.get('roomId') ?? ''));
          const displayName = String(formData.get('displayName') ?? '').trim();
          const nextSession = {
            roomId,
            displayName,
            clientSessionId: generateClientSessionId()
          };
          storeRoomSession(nextSession);
          setSavedSession(nextSession);
          autoRejoinAttemptedRef.current = false;
          setPrefilledRoomId(roomId);
          window.history.replaceState({}, '', `?room=${encodeURIComponent(roomId)}`);
          void joinRoom({
            displayName,
            roomId,
            clientSessionId: nextSession.clientSessionId
          });
        }}
      />
    );
  }

  return (
    <main className="app-shell overflow-hidden bg-[var(--background)] px-3 text-[var(--text-primary)] sm:px-4">
      <div
        className={cn(
          'grid h-full min-h-0 grid-rows-[minmax(0,1fr)_auto] gap-2 overflow-hidden transition-[padding] duration-300 ease-out',
          layoutNeedsRightPadding ? 'pr-[min(372px,calc(100vw-0.75rem))]' : 'pr-0'
        )}
      >
                        <section className="grid min-h-0 gap-2 overflow-hidden">
              {fullscreenParticipant ? (
                <div
                  className={cn(
                    'grid min-h-0 gap-2',
                    gridParticipants.length
                      ? 'xl:grid-rows-[minmax(0,1.02fr)_minmax(0,0.98fr)]'
                      : 'grid-rows-[minmax(0,1fr)]'
                  )}
                >
                  <MediaTile
                    participant={fullscreenParticipant}
                    media={fullscreenMedia}
                    isLocal={fullscreenParticipant.id === localParticipantId}
                    isFullscreen
                    onSelect={toggleFullscreenParticipant}
                    showSelectHint={false}
                    className="h-full min-h-0"
                    audioOutputDeviceId={selectedAudioOutputId}
                    cardColor={participantCardColors.get(fullscreenParticipant.id)}
                  />

                  {gridParticipants.length ? (
                    <div
                      className={cn(
                        'grid h-full min-h-0 auto-rows-fr gap-2 overflow-hidden',
                        galleryLayout.gridClassName
                      )}
                    >
                      {gridParticipants.map((participant) => (
                        <MediaTile
                          key={participant.id}
                          participant={participant}
                          media={participant.id === localParticipantId ? localMedia : remoteStreams.get(participant.id)}
                          isLocal={participant.id === localParticipantId}
                          onSelect={canPinTiles ? toggleFullscreenParticipant : undefined}
                          isFullscreen={participant.id === fullscreenParticipantId}
                          className={galleryLayout.tileClassName}
                          audioOutputDeviceId={selectedAudioOutputId}
                          cardColor={participantCardColors.get(participant.id)}
                        />
                      ))}
                    </div>
                  ) : null}
                </div>
              ) : gridParticipants.length ? (
                <div
                  className={cn(
                    'grid h-full min-h-0 auto-rows-fr gap-2 overflow-hidden',
                    galleryLayout.gridClassName,
                    gridParticipants.length === 1 ? 'h-full' : null
                  )}
                >
                  {gridParticipants.map((participant) => (
                    <MediaTile
                      key={participant.id}
                      participant={participant}
                      media={participant.id === localParticipantId ? localMedia : remoteStreams.get(participant.id)}
                      isLocal={participant.id === localParticipantId}
                      onSelect={canPinTiles ? toggleFullscreenParticipant : undefined}
                      isFullscreen={participant.id === fullscreenParticipantId}
                      className={galleryLayout.tileClassName}
                      audioOutputDeviceId={selectedAudioOutputId}
                      cardColor={participantCardColors.get(participant.id)}
                    />
                  ))}
                </div>
              ) : null}
            </section>

          <nav className="flex shrink-0 justify-center pt-1.5 pb-[calc(env(safe-area-inset-bottom)+0.375rem)] sm:pt-4 sm:pb-[calc(env(safe-area-inset-bottom)+0.25rem)]">
            <div className="flex items-center gap-2 sm:gap-2.5">
              <Button
                size="icon"
                variant="ghost"
                aria-label={localParticipant?.isCameraOn ? 'Выключить камеру' : 'Включить камеру'}
                onClick={toggleCamera}
                className={cn(
                  'size-10 sm:size-11 rounded-full border-0 p-0 shadow-none ring-offset-0 hover:border-0',
                  localParticipant?.isCameraOn
                    ? 'bg-[#f2f3f5] text-[#111214] hover:bg-white hover:text-[#111214]'
                    : 'bg-[#1e1f22] text-white hover:bg-[#2b2d31] hover:text-white'
                )}
              >
                {localParticipant?.isCameraOn ? <Camera className="size-5" /> : <CameraOff className="size-5" />}
              </Button>

              <Button
                size="icon"
                variant="ghost"
                aria-label={isScreenSharing ? 'Остановить демонстрацию экрана' : 'Начать демонстрацию экрана'}
                onClick={() => (isScreenSharing ? void stopScreenShare() : void startScreenShare())}
                disabled={!callState.policy.allowScreenShare && localParticipant?.role !== 'owner'}
                className={cn(
                  'size-10 sm:size-11 rounded-full border-0 p-0 shadow-none ring-offset-0 hover:border-0',
                  isScreenSharing
                    ? 'bg-[#f2f3f5] text-[#111214] hover:bg-white hover:text-[#111214]'
                    : 'bg-[#1e1f22] text-white hover:bg-[#2b2d31] hover:text-white',
                  !callState.policy.allowScreenShare && localParticipant?.role !== 'owner'
                    ? 'bg-[#141518] text-[#6b7280] hover:bg-[#141518] hover:text-[#6b7280]'
                    : null
                )}
              >
                <MonitorUp className="size-5" />
              </Button>

              <Button
                size="icon"
                variant="ghost"
                aria-label={localParticipant?.isMicOn ? 'Выключить микрофон' : 'Включить микрофон'}
                onClick={toggleMicrophone}
                className={cn(
                  'size-10 sm:size-11 rounded-full border-0 p-0 shadow-none ring-offset-0 hover:border-0',
                  localParticipant?.isMicOn
                    ? 'bg-[#1e1f22] text-white hover:bg-[#2b2d31] hover:text-white'
                    : 'bg-[#141518] text-[#8b8d92] hover:bg-[#1b1c20] hover:text-[#b5bac1]'
                )}
              >
                {localParticipant?.isMicOn ? <Mic className="size-5" /> : <MicOff className="size-5" />}
              </Button>

              <Button
                size="icon"
                variant="ghost"
                aria-label={isSidebarOpen ? 'Hide sidebar' : 'Open sidebar'}
                onClick={() => setIsSidebarOpen((current) => !current)}
                className={cn(
                  'size-10 sm:size-11 rounded-full border-0 p-0 shadow-none ring-offset-0 hover:border-0',
                  isSidebarOpen
                    ? 'bg-[#f2f3f5] text-[#111214] hover:bg-white hover:text-[#111214]'
                    : 'bg-[#1e1f22] text-white hover:bg-[#2b2d31] hover:text-white'
                )}
              >
                {isSidebarOpen ? <X className="size-5" /> : <PanelRight className="size-5" />}
              </Button>

              <Button
                size="icon"
                variant="ghost"
                aria-label="Покинуть звонок"
                data-testid="leave-room"
                onClick={handleLeaveRoom}
                className="size-10 sm:size-11 rounded-full border-0 bg-[#ed4245] p-0 text-white shadow-none ring-offset-0 hover:border-0 hover:bg-[#f45b5e] hover:text-white"
              >
                <LogOut className="size-5" />
              </Button>
            </div>
          </nav>

        {showGalleryRail ? (
          <aside className="fixed right-3 top-[calc(env(safe-area-inset-top)+0.75rem)] bottom-[calc(env(safe-area-inset-bottom)+0.75rem)] z-20 w-[min(360px,calc(100vw-1.5rem))] min-w-0 overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--background)] shadow-[0_20px_60px_rgba(0,0,0,0.25)]">
            <ScrollArea className="app-scrollbar h-full min-h-0 pr-1">
              <div className="grid gap-2 p-3">
                {galleryParticipants.map((participant) => (
                  <MediaTile
                    key={participant.id}
                    participant={participant}
                    media={participant.id === localParticipantId ? localMedia : remoteStreams.get(participant.id)}
                    isLocal={participant.id === localParticipantId}
                    onSelect={toggleFullscreenParticipant}
                    isFullscreen={participant.id === fullscreenParticipantId}
                    className="aspect-[1.25/1] min-h-[136px]"
                    audioOutputDeviceId={selectedAudioOutputId}
                    cardColor={participantCardColors.get(participant.id)}
                  />
                ))}
              </div>
            </ScrollArea>
          </aside>
        ) : null}

        <aside
          className={cn(
            'fixed right-3 top-[calc(env(safe-area-inset-top)+0.75rem)] bottom-[calc(env(safe-area-inset-bottom)+0.75rem)] z-40 w-[min(360px,calc(100vw-1.5rem))] min-w-0 overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--background)] shadow-[0_20px_60px_rgba(0,0,0,0.35)] transition-transform duration-300 ease-out',
            isSidebarOpen ? 'translate-x-0' : 'translate-x-[110%]'
          )}
        >
          <Tabs
            value={activePanel}
            onValueChange={(value) => setActivePanel(value as 'chat' | 'participants' | 'settings')}
            className="h-full min-h-0 overflow-hidden"
          >
            <div className="shrink-0 px-3 py-3">
              <div className="flex items-center gap-2">
                <TabsList className="min-w-0 flex-1">
                  <TabsTrigger value="chat" className="flex-1">
                    Чат
                  </TabsTrigger>
                  <TabsTrigger value="participants" className="flex-1">
                    Участники
                  </TabsTrigger>
                  <TabsTrigger value="settings" className="flex-1">
                    Настройки
                  </TabsTrigger>
                </TabsList>
                <button
                  type="button"
                  aria-label="Закрыть боковую панель"
                  className="inline-flex size-11 shrink-0 items-center justify-center rounded-full bg-[rgba(17,18,20,0.72)] text-white backdrop-blur-sm transition-colors duration-200 ease-out hover:bg-[rgba(30,31,34,0.92)] sm:hidden"
                  onClick={() => setIsSidebarOpen(false)}
                >
                  <X className="size-4.5" />
                </button>
              </div>
            </div>

            <TabsContent value="chat" className="min-h-0 overflow-hidden">
              <div className="grid h-full min-h-0 grid-rows-[minmax(0,1fr)_auto] gap-3 overflow-hidden p-3">
                <ScrollArea className="app-scrollbar overflow-x-hidden pr-1">
                  <div className="grid min-w-0 gap-3 overflow-x-hidden">
                    {visibleChatMessages.length ? (
                      visibleChatMessages.map((message) => (
                        <article
                          key={message.id}
                          className={cn('min-w-0 overflow-x-hidden rounded-2xl border p-3 text-sm', statusTone(message))}
                        >
                          <div className="flex min-w-0 items-center justify-between gap-3">
                            <strong className="min-w-0 truncate font-semibold">{message.authorName}</strong>
                            <span className="shrink-0 text-xs text-[var(--text-secondary)]">
                              {new Date(message.createdAt).toLocaleTimeString([], {
                                hour: '2-digit',
                                minute: '2-digit'
                              })}
                            </span>
                          </div>
                          <p className="mt-2 overflow-x-hidden whitespace-pre-wrap break-words [overflow-wrap:anywhere] leading-6">
                            {message.text}
                          </p>
                        </article>
                      ))
                    ) : (
                      <div className="rounded-2xl border border-dashed border-[var(--border-strong)] p-4 text-sm text-[var(--text-secondary)]">
                        Сообщений пока нет. Начните переписку прямо здесь.
                      </div>
                    )}
                  </div>
                </ScrollArea>

                <div className="shrink-0 border-t border-[var(--border)] pt-3">
                  <div className="chat-input-shell relative">
                    <Textarea
                      value={pendingMessage}
                      onChange={(event) => setPendingMessage(event.target.value)}
                      onKeyDown={handleChatInputKeyDown}
                      placeholder="Напишите сообщение в комнату"
                      aria-label="Сообщение в чат"
                      className="chat-input-scrollbar min-h-24 resize-none border-0 rounded-none bg-transparent px-4 py-3 pr-16 focus-visible:ring-0 focus-visible:ring-offset-0"
                    />
                    <Button
                      size="icon"
                      variant="accent"
                      className="absolute bottom-3 right-3 size-10 rounded-full border-[color:var(--accent-border)] bg-[var(--accent)] text-white hover:bg-[#6e8cff]"
                      onClick={sendChatMessage}
                      disabled={!callState.policy.allowChat}
                      aria-label="Отправить сообщение"
                    >
                      <ArrowUp className="size-5" />
                    </Button>
                  </div>
                </div>
              </div>
            </TabsContent>

            <TabsContent value="participants" className="min-h-0 overflow-hidden">
              <div className="grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)_auto] gap-3 overflow-hidden p-3">
                <div className="rounded-2xl border border-[var(--border)] p-4">
                  <div className="text-sm font-semibold">Обзор комнаты</div>
                  <div className="mt-1 text-sm text-[var(--text-secondary)]">
                    Подключено участников: {participants.length}. {callState.policy.allowChat ? 'Чат включён.' : 'Чат выключен.'}
                  </div>
                </div>
                <ScrollArea className="app-scrollbar pr-1">
                  <div className="grid gap-2">
                    {participants.map((participant) => (
                      <ParticipantRow key={participant.id} participant={participant} isLocal={participant.id === localParticipantId} />
                    ))}
                  </div>
                </ScrollArea>
                <div className="shrink-0 rounded-2xl bg-[var(--surface-muted)] p-4 text-sm">
                  <div className="flex items-center justify-between gap-3">
                    <div className="font-semibold text-[var(--text-primary)]">Поделиться комнатой</div>
                    <div className="max-w-[52%] truncate text-[var(--text-secondary)]">{currentRoomId}</div>
                  </div>
                  <Button
                    variant="secondary"
                    className="mt-3 w-full"
                    data-testid="copy-invite-link"
                    onClick={() => void copyInviteLink(currentRoomId)}
                  >
                    <Copy className="size-4" />
                    Скопировать ссылку
                  </Button>
                </div>
              </div>
            </TabsContent>

            <TabsContent value="settings" className="min-h-0 overflow-hidden">
              <div className="grid h-full min-h-0 grid-rows-[minmax(0,1fr)] gap-3 overflow-hidden p-2 sm:p-3">
                <ScrollArea className="app-scrollbar min-w-0 pr-1">
                  <div className="grid min-w-0 gap-3">
                    <section className="min-w-0 rounded-2xl p-3">
                      <div className="text-sm font-semibold">Устройства</div>
                      <div className="mt-3 grid gap-3">

                        <label className="grid min-w-0 gap-2">
                          <span className="text-sm text-[var(--text-secondary)]">Микрофон</span>
                          <SettingsSelect
                            value={selectedAudioInputId}
                            ariaLabel="Выбор микрофона"
                            placeholder="Микрофон по умолчанию"
                            options={devices.audioInputs.map((device) => ({
                              value: device.deviceId,
                              label: device.label || 'Микрофон по умолчанию'
                            }))}
                            onChange={(nextValue) => void applyAudioInput(nextValue)}
                          />
                        </label>
                        <label className="grid min-w-0 gap-2">
                          <span className="text-sm text-[var(--text-secondary)]">Динамики</span>
                          <SettingsSelect
                            value={selectedAudioOutputId}
                            ariaLabel="Выбор устройства вывода звука"
                            placeholder="Устройство вывода по умолчанию"
                            options={[
                              {
                                value: '',
                                label: 'Системное устройство вывода (по умолчанию)'
                              },
                              ...devices.audioOutputs.map((device) => ({
                                value: device.deviceId,
                                label: device.label || 'Устройство вывода по умолчанию'
                              }))
                            ]}
                            onChange={(nextValue) => void applyAudioOutput(nextValue)}
                          />
                        </label>
                        <label className="grid min-w-0 gap-2">
                          <span className="text-sm text-[var(--text-secondary)]">Камера</span>
                          <SettingsSelect
                            value={selectedVideoInputId}
                            ariaLabel="Выбор камеры"
                            placeholder="Камера по умолчанию"
                            options={devices.videoInputs.map((device) => ({
                              value: device.deviceId,
                              label: device.label || 'Камера по умолчанию'
                            }))}
                            onChange={(nextValue) => void applyVideoInput(nextValue)}
                          />
                        </label>
                      </div>
                    </section>
                  </div>
                </ScrollArea>
              </div>
            </TabsContent>
          </Tabs>
        </aside>
      </div>
    </main>
  );
}

type SettingsSelectOption = {
  value: string;
  label: string;
};

const VIRTUAL_DEVICE_PREFIXES = ['По умолчанию - ', 'Оборудование - '];

const stripVirtualDevicePrefix = (label: string) => {
  const prefix = VIRTUAL_DEVICE_PREFIXES.find((candidate) => label.startsWith(candidate));
  return prefix ? label.slice(prefix.length).trim() : label.trim();
};

const SettingsSelect = ({
  value,
  options,
  placeholder,
  ariaLabel,
  onChange
}: {
  value: string;
  options: SettingsSelectOption[];
  placeholder: string;
  ariaLabel: string;
  onChange: (value: string) => void;
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const handlePointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsOpen(false);
      }
    };

    window.addEventListener('mousedown', handlePointerDown);
    window.addEventListener('keydown', handleEscape);

    return () => {
      window.removeEventListener('mousedown', handlePointerDown);
      window.removeEventListener('keydown', handleEscape);
    };
  }, []);

  const selectedOption = options.find((option) => option.value === value) ?? null;
  const selectedBaseLabel = selectedOption ? stripVirtualDevicePrefix(selectedOption.label) : null;
  const filteredOptions = options.filter((option) => {
    if (!selectedBaseLabel) {
      return true;
    }

    const optionBaseLabel = stripVirtualDevicePrefix(option.label);
    const selectedIsVirtual = selectedOption ? stripVirtualDevicePrefix(selectedOption.label) !== selectedOption.label.trim() : false;
    const optionIsPlain = optionBaseLabel === option.label.trim();

    if (selectedIsVirtual && optionIsPlain && optionBaseLabel === selectedBaseLabel) {
      return false;
    }

    return true;
  });
  const orderedOptions = [...filteredOptions].sort((left, right) => {
    const leftIsDefault = left.label.startsWith(VIRTUAL_DEVICE_PREFIXES[0]);
    const rightIsDefault = right.label.startsWith(VIRTUAL_DEVICE_PREFIXES[0]);

    if (leftIsDefault === rightIsDefault) {
      return 0;
    }

    return leftIsDefault ? -1 : 1;
  });

  return (
    <div ref={rootRef} className="relative min-w-0">
      <button
        type="button"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        className="settings-select flex min-h-12 w-full min-w-0 items-start rounded-2xl px-4 py-3 pr-12 text-left text-sm text-[var(--text-primary)] outline-none"
        onClick={() => setIsOpen((current) => !current)}
      >
        <span className="min-w-0 whitespace-normal break-words [overflow-wrap:anywhere] leading-5">
          {selectedOption?.label ?? placeholder}
        </span>
        <ChevronDown
          className={cn(
            'pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-[var(--text-secondary)] transition-transform duration-200 ease-out',
            isOpen ? 'rotate-180' : 'rotate-0'
          )}
        />
      </button>

      {isOpen ? (
        <div className="absolute inset-x-0 top-[calc(100%+0.5rem)] z-20 overflow-hidden rounded-2xl border border-[var(--border-strong)] bg-[var(--surface)] shadow-[0_18px_44px_rgba(4,8,18,0.48)]">
          <div role="listbox" aria-label={ariaLabel} className="app-scrollbar max-h-56 overflow-y-auto overflow-x-hidden p-1">
            {orderedOptions.map((option) => {
              const isSelected = option.value === value;

              return (
                <button
                  key={option.value}
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  className={cn(
                    'flex w-full min-w-0 items-start gap-2 rounded-xl px-3 py-2 text-left text-sm transition-colors duration-150 ease-out',
                    isSelected
                      ? 'bg-[var(--accent-soft)] text-[var(--text-primary)]'
                      : 'text-[var(--text-primary)] hover:bg-[var(--surface-elevated)]'
                  )}
                  onClick={() => {
                    onChange(option.value);
                    setIsOpen(false);
                  }}
                >
                  <span className="min-w-0 flex-1 whitespace-normal break-words [overflow-wrap:anywhere] leading-5">
                    {option.label}
                  </span>
                  {isSelected ? <Check className="size-4 shrink-0 text-[var(--accent)]" /> : null}
                </button>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
};

const ParticipantRow = ({
  participant,
  isLocal
}: {
  participant: Participant;
  isLocal: boolean;
}) => (
  <div className="flex items-center gap-3 rounded-2xl border border-[var(--border)] p-3">
    <Avatar className="size-10">
      <AvatarFallback>{participant.displayName.slice(0, 1).toUpperCase()}</AvatarFallback>
    </Avatar>
    <div className="min-w-0 flex-1">
      <div className="truncate text-sm font-semibold text-[var(--text-primary)]">
        {participant.displayName}
        {isLocal ? ' (Вы)' : ''}
      </div>
      <div className="mt-1 flex flex-wrap gap-2 text-xs text-[var(--text-secondary)]">
        <span>{participant.role === 'owner' ? 'Владелец' : 'Участник'}</span>
        <span>{participant.isMicOn ? 'Микрофон включен' : 'Микрофон выключен'}</span>
        <span>{participant.isCameraOn ? 'Камера включена' : 'Камера выключена'}</span>
        {participant.isSpeaking ? <span className="text-[var(--accent)]">Говорит</span> : null}
      </div>
    </div>
  </div>
);

const PolicyToggle = ({
  label,
  checked,
  disabled,
  onChange
}: {
  label: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) => (
  <label className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-start gap-3 rounded-2xl border border-[var(--border)] px-3 py-3 text-sm">
    <span
      className={cn(
        'min-w-0 break-words pr-1 leading-5 transition-colors duration-200 ease-out',
        disabled ? 'text-[var(--text-secondary)]' : 'text-[var(--text-primary)]'
      )}
    >
      {label}
    </span>
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative mt-0.5 inline-flex h-6 w-11 shrink-0 items-center rounded-full border transition-colors duration-200 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--surface)] disabled:cursor-not-allowed disabled:opacity-50',
        checked ? 'border-[var(--accent)] bg-[var(--accent-soft)]' : 'border-[var(--border)] bg-transparent'
      )}
    >
      <span
        className={cn(
          'mx-0.5 block size-4 rounded-full border border-[var(--border)] bg-[var(--text-primary)] transition-transform duration-200 ease-out',
          checked ? 'translate-x-5' : 'translate-x-0'
        )}
      />
    </button>
  </label>
);

export default App;





