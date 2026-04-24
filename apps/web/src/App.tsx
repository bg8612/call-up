import { useEffect, useState } from 'react';
import {
  AudioLines,
  Camera,
  CameraOff,
  Copy,
  LayoutPanelLeft,
  LogOut,
  MessageSquare,
  Mic,
  MicOff,
  MonitorUp,
  PanelRight,
  Settings,
  Users
} from 'lucide-react';
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
      <div className="mx-auto grid min-h-[calc(100vh-3rem)] max-w-6xl items-center gap-6 lg:grid-cols-[minmax(0,1.15fr)_minmax(360px,420px)]">
        <section className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-6 sm:p-8 lg:p-10">
          <div className="mb-4 inline-flex items-center gap-2 rounded-md border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-1 text-xs font-medium uppercase tracking-[0.22em] text-[var(--text-secondary)]">
            <AudioLines className="size-3.5 text-[var(--accent)]" />
            Mini Meet
          </div>
          <h1 className="max-w-2xl text-4xl font-semibold tracking-tight sm:text-5xl">
            Video meetings with a calmer, more focused control surface
          </h1>
          <p className="mt-4 max-w-2xl text-sm leading-6 text-[var(--text-secondary)] sm:text-base">
            Join a room, keep devices under control, share your screen, and stay on top of chat and room policy
            without leaving the call.
          </p>
          <div className="mt-8 grid gap-3 text-sm text-[var(--text-secondary)] sm:grid-cols-3">
            {[
              ['Stable call stage', 'Pinned speaker area and adaptive participant grid.'],
              ['Focused controls', 'Mic, camera, screen share, chat, and people in one dock.'],
              ['Room governance', 'Policies, invite link, and devices live in a single dark workspace.']
            ].map(([title, description]) => (
              <div key={title} className="rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] p-4">
                <div className="text-sm font-medium text-[var(--text-primary)]">{title}</div>
                <p className="mt-2 text-sm leading-6">{description}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-6 sm:p-8">
          <div className="mb-6">
            <p className="text-xs font-medium uppercase tracking-[0.18em] text-[var(--accent)]">Join room</p>
            <h2 className="mt-2 text-2xl font-semibold">Connect to your call</h2>
            <p className="mt-2 text-sm leading-6 text-[var(--text-secondary)]">
              Devices start off. Turn them on only when you need them.
            </p>
          </div>

          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              onJoin(new FormData(event.currentTarget));
            }}
          >
            <label className="grid gap-2">
              <span className="text-sm font-medium text-[var(--text-secondary)]">Display name</span>
              <Input name="displayName" placeholder="Alexander" required />
            </label>
            <label className="grid gap-2">
              <span className="text-sm font-medium text-[var(--text-secondary)]">Room ID</span>
              <Input
                name="roomId"
                placeholder="team-sync"
                required
                value={roomId}
                onChange={(event) => setRoomId(event.target.value)}
              />
            </label>
            <Button type="submit" variant="accent" className="w-full" disabled={isJoining}>
              {isJoining ? 'Connecting...' : 'Join call'}
            </Button>
          </form>

          {initialRoomId ? (
            <div className="mt-4 rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] px-4 py-3 text-sm text-[var(--text-secondary)]">
              Room ID was prefilled from the invite link.
            </div>
          ) : null}

          {errorMessage ? (
            <div className="mt-4 rounded-lg border border-[var(--danger-border)] bg-[var(--danger-soft)] px-4 py-3 text-sm text-[var(--danger-foreground)]">
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
    ? 'border-[var(--border)] bg-[var(--surface)] text-[var(--text-secondary)]'
    : 'border-[var(--border)] bg-[var(--surface-muted)] text-[var(--text-primary)]';

function App() {
  const [copiedInvite, setCopiedInvite] = useState<string | null>(null);
  const [prefilledRoomId, setPrefilledRoomId] = useState(() => readPrefilledRoomId(window.location.href));
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
    selectedVideoInputId,
    pendingMessage,
    activePanel,
    isConnectingMedia,
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
    applyVideoInput
  } = useCallRoom();

  const copyInviteLink = async (roomId: string) => {
    const inviteLink = buildInviteLink(window.location.origin + window.location.pathname, roomId);
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
    window.history.replaceState({}, '', `?room=${encodeURIComponent(roomId)}`);
    setPrefilledRoomId(roomId);
  };

  if (joinState !== 'joined') {
    return (
      <JoinView
        isJoining={joinState === 'joining'}
        errorMessage={errorMessage}
        initialRoomId={prefilledRoomId}
        onJoin={(formData) => {
          const roomId = String(formData.get('roomId') ?? '').trim();
          setPrefilledRoomId(roomId);
          window.history.replaceState({}, '', `?room=${encodeURIComponent(roomId)}`);
          void joinRoom({
            displayName: String(formData.get('displayName') ?? ''),
            roomId
          });
        }}
      />
    );
  }

  const currentRoomId = prefilledRoomId || readPrefilledRoomId(window.location.href) || 'team-sync';
  const participants = callState.participants;
  const localMedia: RemoteMediaState = {
    cameraStream: localCameraStream ?? undefined,
    screenStream: localScreenStream ?? undefined
  };
  const highlightedParticipantId = selectedPinnedParticipant?.id ?? null;
  const highlightedParticipant = participants.find((participant) => participant.id === highlightedParticipantId) ?? null;
  const gridParticipants = highlightedParticipant
    ? participants.filter((participant) => participant.id !== highlightedParticipant.id)
    : participants;
  const gridLayout = getVideoGridLayout(gridParticipants.length);
  const isScreenSharing = Boolean(localParticipant?.isScreenSharing || localScreenStream);
  const showOwnerActions = localParticipant?.role === 'owner';

  return (
    <main className="min-h-screen bg-[var(--background)] px-3 py-3 text-[var(--text-primary)] sm:px-4 sm:py-4">
      <div className="grid min-h-[calc(100vh-1.5rem)] gap-3 xl:grid-cols-[80px_minmax(0,1fr)_360px]">
        <aside className="flex min-h-[80px] flex-row gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface)] p-2 xl:min-h-full xl:flex-col xl:justify-between">
          <div className="flex flex-1 flex-row gap-2 xl:flex-col">
            <div className="flex h-14 items-center justify-center rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] text-sm font-semibold tracking-[0.12em] text-[var(--accent)]">
              MM
            </div>
            <div className="flex flex-1 flex-row gap-2 xl:flex-col">
              <button
                type="button"
                className="group flex h-12 flex-1 items-center justify-center rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] text-[var(--text-primary)] transition-colors duration-200 ease-out hover:bg-[var(--surface-elevated)] xl:flex-none"
                aria-label={`Current room ${currentRoomId}`}
              >
                <LayoutPanelLeft className="size-4" />
              </button>
              <button
                type="button"
                className={cn(
                  'group relative flex h-12 flex-1 items-center justify-center rounded-lg border transition-colors duration-200 ease-out xl:flex-none',
                  activePanel === 'participants'
                    ? 'border-[var(--border-strong)] bg-[var(--surface-elevated)] text-[var(--text-primary)]'
                    : 'border-[var(--border)] bg-[var(--surface-muted)] text-[var(--text-secondary)] hover:bg-[var(--surface-elevated)] hover:text-[var(--text-primary)]'
                )}
                aria-label="Open participants"
                onClick={() => setActivePanel('participants')}
              >
                <span className="absolute left-0 top-2 hidden h-7 w-0.5 rounded-r bg-[var(--accent)] xl:block" />
                <Users className="size-4" />
              </button>
              <button
                type="button"
                className={cn(
                  'group relative flex h-12 flex-1 items-center justify-center rounded-lg border transition-colors duration-200 ease-out xl:flex-none',
                  activePanel === 'chat'
                    ? 'border-[var(--border-strong)] bg-[var(--surface-elevated)] text-[var(--text-primary)]'
                    : 'border-[var(--border)] bg-[var(--surface-muted)] text-[var(--text-secondary)] hover:bg-[var(--surface-elevated)] hover:text-[var(--text-primary)]'
                )}
                aria-label="Open chat"
                onClick={() => setActivePanel('chat')}
              >
                <span className="absolute left-0 top-2 hidden h-7 w-0.5 rounded-r bg-[var(--accent)] xl:block" />
                <MessageSquare className="size-4" />
              </button>
            </div>
          </div>

          <div className="flex items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] p-2 xl:flex-col">
            <Avatar className="size-10">
              <AvatarFallback>{localParticipant?.displayName.slice(0, 1).toUpperCase() || 'Y'}</AvatarFallback>
            </Avatar>
            <div className="hidden min-w-0 flex-1 xl:block">
              <div className="truncate text-sm font-medium">{localParticipant?.displayName || 'You'}</div>
              <div className="truncate text-xs text-[var(--text-secondary)]">{localParticipant?.role || 'participant'}</div>
            </div>
            <Button
              size="icon"
              variant="ghost"
              aria-label="Open settings"
              className="size-9"
              onClick={() => setActivePanel('settings')}
            >
              <Settings className="size-4" />
            </Button>
          </div>
        </aside>

        <section className="grid min-h-0 gap-3 xl:grid-rows-[auto_minmax(0,1fr)_auto]">
          <header className="flex flex-col gap-4 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-4 py-4 lg:flex-row lg:items-center lg:justify-between lg:px-5">
            <div>
              <div className="text-xs font-medium uppercase tracking-[0.18em] text-[var(--accent)]">Live room</div>
              <h1 className="mt-2 text-2xl font-semibold tracking-tight sm:text-3xl">{currentRoomId}</h1>
              <p className="mt-1 text-sm text-[var(--text-secondary)]">
                {participants.length} participants online. Devices stay off until someone explicitly turns them on.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <div className="inline-flex items-center gap-2 rounded-md border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2 text-sm text-[var(--text-secondary)]">
                <span
                  className={cn(
                    'size-2 rounded-full border border-transparent',
                    isConnectingMedia ? 'bg-[var(--warning)]' : 'bg-[var(--success)]'
                  )}
                />
                {isConnectingMedia ? 'Connecting devices' : 'Call active'}
              </div>
              <div className="inline-flex items-center gap-2 rounded-md border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2 text-sm text-[var(--text-secondary)]">
                <Users className="size-4" />
                {participants.length}
              </div>
              <Button variant="secondary" className="min-w-0" onClick={() => void copyInviteLink(currentRoomId)}>
                <Copy className="size-4" />
                Copy invite
              </Button>
            </div>
          </header>

          <section className="grid min-h-0 gap-3">
            {(errorMessage || copiedInvite) && (
              <div className="grid gap-2">
                {errorMessage ? (
                  <div className="rounded-lg border border-[var(--danger-border)] bg-[var(--danger-soft)] px-4 py-3 text-sm text-[var(--danger-foreground)]">
                    {errorMessage}
                  </div>
                ) : null}
                {copiedInvite ? (
                  <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-4 py-3 text-sm text-[var(--text-secondary)]">
                    Invite link copied: <span className="text-[var(--text-primary)]">{copiedInvite}</span>
                  </div>
                ) : null}
              </div>
            )}

            {highlightedParticipant ? (
              <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-3">
                <div className="mb-3 flex items-center justify-between gap-3 px-1">
                  <div>
                    <div className="text-xs font-medium uppercase tracking-[0.16em] text-[var(--text-secondary)]">
                      Focused stage
                    </div>
                    <div className="mt-1 text-sm text-[var(--text-primary)]">{highlightedParticipant.displayName}</div>
                  </div>
                  <div className="rounded-md border border-[var(--border)] bg-[var(--surface-muted)] px-2.5 py-1 text-xs text-[var(--text-secondary)]">
                    {highlightedParticipant.isScreenSharing ? 'Screen share' : 'Pinned participant'}
                  </div>
                </div>
                <MediaTile
                  key={highlightedParticipant.id}
                  participant={highlightedParticipant}
                  media={highlightedParticipant.id === localParticipantId ? localMedia : remoteStreams.get(highlightedParticipant.id)}
                  isLocal={highlightedParticipant.id === localParticipantId}
                  onPin={pinParticipant}
                  className="min-h-[360px]"
                />
              </div>
            ) : null}

            <div className="flex min-h-0 flex-1 flex-col rounded-lg border border-[var(--border)] bg-[var(--surface)] p-3">
              <div className="mb-3 flex items-center justify-between gap-3 px-1">
                <div>
                  <div className="text-sm font-medium">Participants on stage</div>
                  <div className="text-xs text-[var(--text-secondary)]">Adaptive grid tuned for call stability.</div>
                </div>
                <div className="rounded-md border border-[var(--border)] bg-[var(--surface-muted)] px-2.5 py-1 text-xs text-[var(--text-secondary)]">
                  {gridParticipants.length} visible
                </div>
              </div>

              {gridParticipants.length ? (
                <div
                  className={cn(
                    'grid min-h-0 flex-1 gap-3 sm:grid-cols-2',
                    gridLayout.gridClassName,
                    gridLayout.isCompact && 'auto-rows-fr'
                  )}
                >
                  {gridParticipants.map((participant) => (
                    <MediaTile
                      key={participant.id}
                      participant={participant}
                      media={participant.id === localParticipantId ? localMedia : remoteStreams.get(participant.id)}
                      isLocal={participant.id === localParticipantId}
                      onPin={pinParticipant}
                    />
                  ))}
                </div>
              ) : (
                <div className="flex min-h-[240px] flex-1 items-center justify-center rounded-lg border border-dashed border-[var(--border-strong)] bg-[var(--surface-muted)] px-6 text-center text-sm text-[var(--text-secondary)]">
                  Pin someone to the focused stage or wait for new participants to join the room.
                </div>
              )}
            </div>
          </section>

          <nav className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  variant={localParticipant?.isMicOn ? 'accent' : 'secondary'}
                  aria-label={localParticipant?.isMicOn ? 'Mute microphone' : 'Unmute microphone'}
                  onClick={toggleMicrophone}
                >
                  {localParticipant?.isMicOn ? <Mic className="size-4" /> : <MicOff className="size-4" />}
                  <span>{localParticipant?.isMicOn ? 'Mic on' : 'Mic off'}</span>
                </Button>
                <Button
                  variant={localParticipant?.isCameraOn ? 'accent' : 'secondary'}
                  aria-label={localParticipant?.isCameraOn ? 'Turn camera off' : 'Turn camera on'}
                  onClick={toggleCamera}
                >
                  {localParticipant?.isCameraOn ? <Camera className="size-4" /> : <CameraOff className="size-4" />}
                  <span>{localParticipant?.isCameraOn ? 'Camera on' : 'Camera off'}</span>
                </Button>
                <Button
                  variant={isScreenSharing ? 'accent' : 'secondary'}
                  aria-label={isScreenSharing ? 'Stop screen share' : 'Start screen share'}
                  onClick={() => (isScreenSharing ? void stopScreenShare() : void startScreenShare())}
                  disabled={!callState.policy.allowScreenShare && localParticipant?.role !== 'owner'}
                >
                  <MonitorUp className="size-4" />
                  <span>{isScreenSharing ? 'Stop share' : 'Share screen'}</span>
                </Button>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <Button
                  variant={activePanel === 'chat' ? 'accent' : 'secondary'}
                  aria-label="Toggle chat panel"
                  onClick={() => setActivePanel('chat')}
                >
                  <MessageSquare className="size-4" />
                  <span>Chat</span>
                </Button>
                <Button
                  variant={activePanel === 'participants' ? 'accent' : 'secondary'}
                  aria-label="Toggle participants panel"
                  onClick={() => setActivePanel('participants')}
                >
                  <PanelRight className="size-4" />
                  <span>People</span>
                </Button>
                <Button variant="danger" aria-label="Leave call" onClick={leaveRoom}>
                  <LogOut className="size-4" />
                  <span>Leave</span>
                </Button>
              </div>
            </div>
          </nav>
        </section>

        <aside className="min-h-[420px] rounded-lg border border-[var(--border)] bg-[var(--surface)] xl:min-h-full">
          <Tabs value={activePanel} onValueChange={(value) => setActivePanel(value as 'chat' | 'participants' | 'settings')} className="h-full min-h-0">
            <div className="border-b border-[var(--border)] px-3 py-3">
              <TabsList className="w-full">
                <TabsTrigger value="chat" className="flex-1">
                  Chat
                </TabsTrigger>
                <TabsTrigger value="participants" className="flex-1">
                  People
                </TabsTrigger>
                <TabsTrigger value="settings" className="flex-1">
                  Settings
                </TabsTrigger>
              </TabsList>
            </div>

            <TabsContent value="chat" className="h-[calc(100%-4.5rem)]">
              <div className="grid h-full min-h-0 grid-rows-[minmax(0,1fr)_auto] gap-4 p-3">
                <ScrollArea className="app-scrollbar pr-1">
                  <div className="grid gap-3">
                    {callState.chatMessages.length ? (
                      callState.chatMessages.map((message) => (
                        <article key={message.id} className={cn('rounded-lg border p-3 text-sm', statusTone(message))}>
                          <div className="flex items-center justify-between gap-3">
                            <strong className="font-medium">{message.authorName}</strong>
                            <span className="text-xs text-[var(--text-secondary)]">
                              {new Date(message.createdAt).toLocaleTimeString([], {
                                hour: '2-digit',
                                minute: '2-digit'
                              })}
                            </span>
                          </div>
                          <p className="mt-2 whitespace-pre-wrap leading-6">{message.text}</p>
                        </article>
                      ))
                    ) : (
                      <div className="rounded-lg border border-dashed border-[var(--border-strong)] bg-[var(--surface-muted)] p-4 text-sm text-[var(--text-secondary)]">
                        No messages yet. Start the room conversation here.
                      </div>
                    )}
                  </div>
                </ScrollArea>

                <div className="space-y-3 border-t border-[var(--border)] pt-4">
                  <Textarea
                    value={pendingMessage}
                    onChange={(event) => setPendingMessage(event.target.value)}
                    placeholder="Write a message to the room"
                    aria-label="Chat message"
                    className="min-h-28 resize-none"
                  />
                  <Button className="w-full" variant="accent" onClick={sendChatMessage} disabled={!callState.policy.allowChat}>
                    Send message
                  </Button>
                </div>
              </div>
            </TabsContent>

            <TabsContent value="participants" className="h-[calc(100%-4.5rem)]">
              <div className="grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)_auto] gap-4 p-3">
                <div className="rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] p-4">
                  <div className="text-sm font-medium">Room overview</div>
                  <div className="mt-1 text-sm text-[var(--text-secondary)]">
                    {participants.length} people connected. {callState.policy.allowChat ? 'Chat enabled.' : 'Chat disabled.'}
                  </div>
                </div>
                <ScrollArea className="app-scrollbar pr-1">
                  <div className="grid gap-2">
                    {participants.map((participant) => (
                      <ParticipantRow
                        key={participant.id}
                        participant={participant}
                        isLocal={participant.id === localParticipantId}
                        onPin={pinParticipant}
                      />
                    ))}
                  </div>
                </ScrollArea>
                <div className="rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] p-4 text-sm">
                  <div className="font-medium text-[var(--text-primary)]">Share room</div>
                  <div className="mt-1 text-[var(--text-secondary)]">{currentRoomId}</div>
                  <Button variant="secondary" className="mt-3 w-full" onClick={() => void copyInviteLink(currentRoomId)}>
                    <Copy className="size-4" />
                    Copy invite link
                  </Button>
                </div>
              </div>
            </TabsContent>

            <TabsContent value="settings" className="h-[calc(100%-4.5rem)]">
              <div className="grid h-full min-h-0 grid-rows-[minmax(0,1fr)] gap-4 p-3">
                <ScrollArea className="app-scrollbar pr-1">
                  <div className="grid gap-4">
                    <section className="rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] p-4">
                      <div className="text-sm font-medium">Devices</div>
                      <div className="mt-4 grid gap-4">
                        <label className="grid gap-2">
                          <span className="text-sm text-[var(--text-secondary)]">Microphone</span>
                          <select
                            className="h-10 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 text-sm text-[var(--text-primary)] outline-none transition-colors duration-200 ease-out focus-visible:border-[var(--border-strong)]"
                            value={selectedAudioInputId}
                            aria-label="Select microphone"
                            onChange={(event) => void applyAudioInput(event.target.value)}
                          >
                            {devices.audioInputs.map((device) => (
                              <option key={device.deviceId} value={device.deviceId}>
                                {device.label || 'Audio input'}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label className="grid gap-2">
                          <span className="text-sm text-[var(--text-secondary)]">Camera</span>
                          <select
                            className="h-10 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 text-sm text-[var(--text-primary)] outline-none transition-colors duration-200 ease-out focus-visible:border-[var(--border-strong)]"
                            value={selectedVideoInputId}
                            aria-label="Select camera"
                            onChange={(event) => void applyVideoInput(event.target.value)}
                          >
                            {devices.videoInputs.map((device) => (
                              <option key={device.deviceId} value={device.deviceId}>
                                {device.label || 'Video input'}
                              </option>
                            ))}
                          </select>
                        </label>
                      </div>
                    </section>

                    <section className="rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] p-4">
                      <div className="text-sm font-medium">Room controls</div>
                      <div className="mt-4 grid gap-3">
                        <PolicyToggle
                          label="Allow chat"
                          checked={callState.policy.allowChat}
                          disabled={!showOwnerActions}
                          onChange={(checked) => updatePolicy({ allowChat: checked })}
                        />
                        <PolicyToggle
                          label="Allow screen sharing"
                          checked={callState.policy.allowScreenShare}
                          disabled={!showOwnerActions}
                          onChange={(checked) => updatePolicy({ allowScreenShare: checked })}
                        />
                        <PolicyToggle
                          label="Allow system audio"
                          checked={callState.policy.allowSystemAudio}
                          disabled={!showOwnerActions}
                          onChange={(checked) => updatePolicy({ allowSystemAudio: checked })}
                        />
                      </div>
                      {!showOwnerActions ? (
                        <p className="mt-3 text-xs text-[var(--text-secondary)]">
                          Only the room owner can change these settings.
                        </p>
                      ) : null}
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

const ParticipantRow = ({
  participant,
  isLocal,
  onPin
}: {
  participant: Participant;
  isLocal: boolean;
  onPin: (participantId: string | null) => void;
}) => (
  <div className="flex items-center gap-3 rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] p-3">
    <Avatar className="size-10">
      <AvatarFallback>{participant.displayName.slice(0, 1).toUpperCase()}</AvatarFallback>
    </Avatar>
    <div className="min-w-0 flex-1">
      <div className="truncate text-sm font-medium text-[var(--text-primary)]">
        {participant.displayName}
        {isLocal ? ' (You)' : ''}
      </div>
      <div className="mt-1 flex flex-wrap gap-2 text-xs text-[var(--text-secondary)]">
        <span>{participant.role === 'owner' ? 'Owner' : 'Participant'}</span>
        <span>{participant.isMicOn ? 'Mic on' : 'Mic muted'}</span>
        <span>{participant.isCameraOn ? 'Camera on' : 'Camera off'}</span>
        {participant.isSpeaking ? <span className="text-[var(--accent)]">Speaking</span> : null}
      </div>
    </div>
    <Button
      variant={participant.isPinned ? 'accent' : 'ghost'}
      size="sm"
      aria-label={participant.isPinned ? `Unpin ${participant.displayName}` : `Pin ${participant.displayName}`}
      onClick={() => onPin(participant.isPinned ? null : participant.id)}
    >
      {participant.isPinned ? 'Pinned' : 'Pin'}
    </Button>
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
  <label className="flex items-center justify-between gap-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-3 text-sm">
    <span className={cn('transition-colors duration-200 ease-out', disabled ? 'text-[var(--text-secondary)]' : 'text-[var(--text-primary)]')}>
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
        'relative inline-flex h-6 w-11 items-center rounded-full border transition-colors duration-200 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--surface)] disabled:cursor-not-allowed disabled:opacity-50',
        checked ? 'border-[var(--accent)] bg-[var(--accent-soft)]' : 'border-[var(--border)] bg-[var(--surface-muted)]'
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
