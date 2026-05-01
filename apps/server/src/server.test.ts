import { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { io as createClient, type Socket } from 'socket.io-client';

type JoinAck =
  | {
      ok: true;
      participantId: string;
      clientSessionId: string;
      sessionToken: string;
      roomId: string;
      participants: Array<{
        id: string;
        socketId: string;
        displayName: string;
        role: 'owner' | 'participant';
        joinedAt: number;
        isPinned: boolean;
        connectionState: 'connected' | 'reconnecting';
        isCameraOn: boolean;
        isMicOn: boolean;
        isSpeaking: boolean;
        isScreenSharing: boolean;
        isSharingAudio: boolean;
        cameraStreamId?: string;
        screenStreamId?: string;
      }>;
      chatMessages: Array<{
        id: string;
        authorId: string;
        authorName: string;
        text: string;
        kind: 'user' | 'system';
        createdAt: number;
      }>;
      policy: {
        allowChat: boolean;
        allowScreenShare: boolean;
        allowSystemAudio: boolean;
      };
    }
  | { ok: false; error: string };

type AppServer = Awaited<ReturnType<typeof import('./server.js')['createAppServer']>>;

const nextRoomId = () => `room_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

const once = <T>(socket: Socket, event: string) =>
  new Promise<T>((resolve) => {
    socket.once(event, (payload: T) => {
      resolve(payload);
    });
  });

const onceWithTimeout = <T>(socket: Socket, event: string, timeoutMs = 600) =>
  new Promise<T | null>((resolve) => {
    const timer = setTimeout(() => {
      socket.off(event, onEvent);
      resolve(null);
    }, timeoutMs);

    const onEvent = (payload: T) => {
      clearTimeout(timer);
      resolve(payload);
    };

    socket.once(event, onEvent);
  });

const connectClient = async (serverUrl: string) => {
  const socket = createClient(serverUrl, {
    transports: ['websocket'],
    reconnection: false
  });

  await new Promise<void>((resolve, reject) => {
    socket.once('connect', () => resolve());
    socket.once('connect_error', reject);
  });

  return socket;
};

const joinRoom = async (
  socket: Socket,
  payload: {
    roomId: string;
    displayName: string;
    anonymousAuthToken?: string;
    clientSessionId?: string;
    sessionToken?: string;
  }
) =>
  new Promise<Extract<JoinAck, { ok: true }>>((resolve, reject) => {
    socket.emit(
      'room:join',
      {
        ...payload,
        anonymousAuthToken:
          payload.anonymousAuthToken ??
          `anon-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`
      },
      (response: JoinAck) => {
      if (!response.ok) {
        reject(new Error(response.error));
        return;
      }

      resolve(response);
      }
    );
  });

describe('createAppServer', () => {
  let serverUrl = '';
  let appServer: AppServer | null = null;
  const sockets: Socket[] = [];

  beforeEach(async () => {
    vi.useRealTimers();
    vi.resetModules();

    const { createAppServer } = await import('./server.js');
    appServer = createAppServer();

    await new Promise<void>((resolve) => {
      appServer!.httpServer.listen(0, '127.0.0.1', () => resolve());
    });

    const address = appServer.httpServer.address() as AddressInfo;
    serverUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    vi.useRealTimers();

    for (const socket of sockets) {
      if (socket.connected) {
        socket.disconnect();
      }
      socket.removeAllListeners();
    }
    sockets.length = 0;

    if (appServer) {
      await new Promise<void>((resolve, reject) => {
        appServer!.io.close();
        appServer!.httpServer.close((closeError) => {
          if (closeError && closeError.message !== 'Server is not running.') {
            reject(closeError);
            return;
          }

          resolve();
        });
      });
    }

    appServer = null;
  });

  it('creates a room and returns the initial participant snapshot on join', async () => {
    const roomId = nextRoomId();
    const ownerSocket = await connectClient(serverUrl);
    sockets.push(ownerSocket);

    const joinAck = await joinRoom(ownerSocket, {
      roomId,
      displayName: 'Alex',
      clientSessionId: 'client-owner-1234'
    });

    expect(joinAck.roomId).toBe(roomId);
    expect(joinAck.participantId).toMatch(/^p_/);
    expect(joinAck.clientSessionId.length).toBeGreaterThan(20);
    expect(joinAck.sessionToken).toBe(joinAck.clientSessionId);
    expect(joinAck.participants).toHaveLength(1);
    expect(joinAck.participants[0]).toMatchObject({
      id: joinAck.participantId,
      displayName: 'Alex',
      role: 'owner',
      connectionState: 'connected',
      isCameraOn: false,
      isMicOn: false,
      isSpeaking: false,
      isScreenSharing: false,
      isSharingAudio: false
    });
    expect(joinAck.chatMessages).toEqual([
      expect.objectContaining({
        kind: 'system',
        text: 'Alex joined the room'
      })
    ]);
    expect(joinAck.policy).toEqual({
      allowChat: true,
      allowScreenShare: true,
      allowSystemAudio: true
    });

    const healthResponse = await fetch(`${serverUrl}/health`);
    expect(healthResponse.ok).toBe(true);
    await expect(healthResponse.json()).resolves.toMatchObject({
      ok: true,
      rooms: 1,
      status: 'ok',
      issues: [],
      uptimeSec: expect.any(Number),
      memory: {
        rss: expect.any(Number),
        heapUsed: expect.any(Number),
        heapTotal: expect.any(Number),
        external: expect.any(Number)
      },
      metrics: {
        activeRooms: 1,
        activeSocketConnections: expect.any(Number),
        activeSocketSessions: 1,
        reconnectTimers: 0
      }
    });
  });

  it('notifies other participants when someone joins and when they explicitly leave', async () => {
    const roomId = nextRoomId();
    const ownerSocket = await connectClient(serverUrl);
    const guestSocket = await connectClient(serverUrl);
    sockets.push(ownerSocket, guestSocket);

    await joinRoom(ownerSocket, {
      roomId,
      displayName: 'Alex',
      clientSessionId: 'client-owner-2222'
    });

    const joinedEvent = once<{
      participant: { id: string; displayName: string; role: 'owner' | 'participant' };
      message: { kind: 'system'; text: string };
    }>(ownerSocket, 'participant:joined');

    const guestJoinAck = await joinRoom(guestSocket, {
      roomId,
      displayName: 'Mira',
      clientSessionId: 'client-guest-2222'
    });

    await expect(joinedEvent).resolves.toMatchObject({
      participant: {
        id: guestJoinAck.participantId,
        displayName: 'Mira',
        role: 'participant'
      },
      message: {
        kind: 'system',
        text: 'Mira joined the room'
      }
    });

    const leftEvent = once<{
      participantId: string;
      participants: Array<{ id: string; displayName: string; role: 'owner' | 'participant' }>;
      message: { kind: 'system'; text: string };
    }>(ownerSocket, 'participant:left');

    guestSocket.emit('room:leave');

    await expect(leftEvent).resolves.toMatchObject({
      participantId: guestJoinAck.participantId,
      participants: [
        expect.objectContaining({
          displayName: 'Alex',
          role: 'owner'
        })
      ],
      message: {
        kind: 'system',
        text: 'Mira left the room'
      }
    });
  });

  it('removes room broadcast access immediately after room:leave', async () => {
    const roomId = nextRoomId();
    const ownerSocket = await connectClient(serverUrl);
    const guestSocket = await connectClient(serverUrl);
    sockets.push(ownerSocket, guestSocket);

    await joinRoom(ownerSocket, {
      roomId,
      displayName: 'Alex',
      clientSessionId: 'client-owner-leave-1'
    });
    await joinRoom(guestSocket, {
      roomId,
      displayName: 'Mira',
      clientSessionId: 'client-guest-leave-1'
    });

    const ownerSawLeave = once(ownerSocket, 'participant:left');
    guestSocket.emit('room:leave');
    await ownerSawLeave;

    ownerSocket.emit('chat:send', { text: 'after-leave' });
    ownerSocket.emit('room:policy', { allowChat: false });

    await expect(onceWithTimeout(guestSocket, 'chat:received')).resolves.toBeNull();
    await expect(onceWithTimeout(guestSocket, 'room:policy-updated')).resolves.toBeNull();
    await expect(onceWithTimeout(guestSocket, 'room:policy-enforced')).resolves.toBeNull();
    await expect(onceWithTimeout(guestSocket, 'participant:left')).resolves.toBeNull();
  });

  it('rejects join when anonymous authorization token is missing', async () => {
    const roomId = nextRoomId();
    const socket = await connectClient(serverUrl);
    sockets.push(socket);

    const failedAck = await new Promise<JoinAck>((resolve) => {
      socket.emit(
        'room:join',
        {
          roomId,
          displayName: 'Alex',
          clientSessionId: 'client-missing-anon-token-1'
        },
        (response: JoinAck) => resolve(response)
      );
    });

    expect(failedAck).toMatchObject({
      ok: false,
      error: 'Anonymous authorization token is required'
    });
  });

  it('rejects repeated join to the same room from the same anonymous token', async () => {
    const roomId = nextRoomId();
    const anonymousAuthToken = 'anon-repeat-same-room-1';
    const firstSocket = await connectClient(serverUrl);
    const secondSocket = await connectClient(serverUrl);
    sockets.push(firstSocket, secondSocket);

    await joinRoom(firstSocket, {
      roomId,
      displayName: 'Alex',
      anonymousAuthToken,
      clientSessionId: 'client-repeat-same-room-1'
    });

    const failedAck = await new Promise<JoinAck>((resolve) => {
      secondSocket.emit(
        'room:join',
        {
          roomId,
          displayName: 'Alex clone',
          anonymousAuthToken,
          clientSessionId: 'client-repeat-same-room-2'
        },
        (response: JoinAck) => resolve(response)
      );
    });

    expect(failedAck).toMatchObject({
      ok: false,
      error: 'This browser has already joined this room. Re-entry is blocked for the same anonymous token.'
    });
  });

  it('moves anonymous token binding to another room and finalizes previous participant', async () => {
    const anonymousAuthToken = 'anon-repeat-cross-room-1';
    const roomA = nextRoomId();
    const roomB = nextRoomId();
    const firstSocket = await connectClient(serverUrl);
    const observerSocket = await connectClient(serverUrl);
    const secondSocket = await connectClient(serverUrl);
    sockets.push(firstSocket, observerSocket, secondSocket);

    await joinRoom(firstSocket, {
      roomId: roomA,
      displayName: 'Alex',
      anonymousAuthToken,
      clientSessionId: 'client-cross-room-1'
    });
    await joinRoom(observerSocket, {
      roomId: roomA,
      displayName: 'Mira',
      clientSessionId: 'client-cross-room-observer'
    });

    const oldRoomLeft = once<{
      participantId: string;
      participants: Array<{ displayName: string }>;
      message: { text: string };
    }>(observerSocket, 'participant:left');
    const roomBAck = await joinRoom(secondSocket, {
      roomId: roomB,
      displayName: 'Alex clone',
      anonymousAuthToken,
      clientSessionId: 'client-cross-room-2'
    });

    expect(roomBAck.roomId).toBe(roomB);
    await expect(oldRoomLeft).resolves.toMatchObject({
      participants: [expect.objectContaining({ displayName: 'Mira' })],
      message: { text: 'Alex left the room' }
    });
  });

  it('allows joining again with the same anonymous token after explicit leave', async () => {
    const roomId = nextRoomId();
    const anonymousAuthToken = 'anon-rejoin-after-leave-1';
    const firstSocket = await connectClient(serverUrl);
    const secondSocket = await connectClient(serverUrl);
    const thirdSocket = await connectClient(serverUrl);
    sockets.push(firstSocket, secondSocket, thirdSocket);

    await joinRoom(firstSocket, {
      roomId,
      displayName: 'Alex',
      anonymousAuthToken,
      clientSessionId: 'client-rejoin-after-leave-1'
    });

    await new Promise<void>((resolve) => {
      firstSocket.emit('room:leave', () => resolve());
    });

    const sameRoomAck = await joinRoom(secondSocket, {
      roomId,
      displayName: 'Alex again',
      anonymousAuthToken,
      clientSessionId: 'client-rejoin-after-leave-2'
    });
    expect(sameRoomAck.roomId).toBe(roomId);

    await new Promise<void>((resolve) => {
      secondSocket.emit('room:leave', () => resolve());
    });

    const otherRoomAck = await joinRoom(thirdSocket, {
      roomId: nextRoomId(),
      displayName: 'Alex other room',
      anonymousAuthToken,
      clientSessionId: 'client-rejoin-after-leave-3'
    });
    expect(otherRoomAck.ok).toBe(true);
  });

  it('allows joining again with the same anonymous token after reconnect grace finalization', async () => {
    const roomA = nextRoomId();
    const roomB = nextRoomId();
    const anonymousAuthToken = 'anon-rejoin-after-timeout-1';
    const firstSocket = await connectClient(serverUrl);
    const secondSocket = await connectClient(serverUrl);
    sockets.push(firstSocket, secondSocket);

    await joinRoom(firstSocket, {
      roomId: roomA,
      displayName: 'Alex',
      anonymousAuthToken,
      clientSessionId: 'client-rejoin-after-timeout-1'
    });

    vi.useFakeTimers();
    appServer!.io.sockets.sockets.get(firstSocket.id)?.disconnect(true);
    await vi.advanceTimersByTimeAsync(15_000);
    vi.useRealTimers();

    const joinAfterTimeoutAck = await joinRoom(secondSocket, {
      roomId: roomB,
      displayName: 'Alex after timeout',
      anonymousAuthToken,
      clientSessionId: 'client-rejoin-after-timeout-2'
    });

    expect(joinAfterTimeoutAck.roomId).toBe(roomB);
  });

  it('does not emit a second leave when disconnect happens after explicit room:leave', async () => {
    const roomId = nextRoomId();
    const ownerSocket = await connectClient(serverUrl);
    const guestSocket = await connectClient(serverUrl);
    sockets.push(ownerSocket, guestSocket);

    await joinRoom(ownerSocket, {
      roomId,
      displayName: 'Alex',
      clientSessionId: 'client-owner-leave-disconnect-1'
    });
    const guestJoinAck = await joinRoom(guestSocket, {
      roomId,
      displayName: 'Mira',
      clientSessionId: 'client-guest-leave-disconnect-1'
    });

    const firstLeftEvent = once<{
      participantId: string;
      message: { kind: 'system'; text: string };
    }>(ownerSocket, 'participant:left');
    guestSocket.emit('room:leave');

    await expect(firstLeftEvent).resolves.toMatchObject({
      participantId: guestJoinAck.participantId,
      message: { text: 'Mira left the room' }
    });

    guestSocket.disconnect();

    await expect(onceWithTimeout(ownerSocket, 'participant:left')).resolves.toBeNull();
    await expect(onceWithTimeout(ownerSocket, 'participant:updated')).resolves.toBeNull();
  });

  it('marks a participant as reconnecting and removes them after the grace period', async () => {
    const roomId = nextRoomId();
    const ownerSocket = await connectClient(serverUrl);
    const guestSocket = await connectClient(serverUrl);
    sockets.push(ownerSocket, guestSocket);

    await joinRoom(ownerSocket, {
      roomId,
      displayName: 'Alex',
      clientSessionId: 'client-owner-3333'
    });
    const guestJoinAck = await joinRoom(guestSocket, {
      roomId,
      displayName: 'Mira',
      clientSessionId: 'client-guest-3333'
    });

    const ownerViewOfDisconnect = once<{
      participant: { id: string; connectionState: 'connected' | 'reconnecting' };
    }>(ownerSocket, 'participant:updated');

    vi.useFakeTimers();

    appServer!.io.sockets.sockets.get(guestSocket.id)?.disconnect(true);

    await expect(ownerViewOfDisconnect).resolves.toMatchObject({
      participant: {
        id: guestJoinAck.participantId,
        connectionState: 'reconnecting'
      }
    });

    const removedEvent = once<{
      participantId: string;
      participants: Array<{ id: string }>;
      message: { kind: 'system'; text: string };
    }>(ownerSocket, 'participant:left');

    await vi.advanceTimersByTimeAsync(15_000);

    await expect(removedEvent).resolves.toMatchObject({
      participantId: guestJoinAck.participantId,
      participants: [expect.objectContaining({ id: expect.any(String) })],
      message: {
        kind: 'system',
        text: 'Mira left the room'
      }
    });
  });

  it('restores the same participant on rejoin with a server-issued session token', async () => {
    const roomId = nextRoomId();
    const guestAnonymousToken = 'anon-rejoin-token-room-1';
    const ownerSocket = await connectClient(serverUrl);
    const guestSocket = await connectClient(serverUrl);
    sockets.push(ownerSocket, guestSocket);

    await joinRoom(ownerSocket, {
      roomId,
      displayName: 'Alex',
      clientSessionId: 'client-owner-4444'
    });
    const guestJoinAck = await joinRoom(guestSocket, {
      roomId,
      displayName: 'Mira',
      anonymousAuthToken: guestAnonymousToken,
      clientSessionId: 'client-guest-4444'
    });

    vi.useFakeTimers();
    appServer!.io.sockets.sockets.get(guestSocket.id)?.disconnect(true);

    const reconnectingEvent = once<{
      participant: { id: string; connectionState: 'connected' | 'reconnecting' };
    }>(ownerSocket, 'participant:updated');
    await vi.advanceTimersByTimeAsync(0);
    await expect(reconnectingEvent).resolves.toMatchObject({
      participant: {
        id: guestJoinAck.participantId,
        connectionState: 'reconnecting'
      }
    });

    vi.useRealTimers();

    const rejoinedSocket = await connectClient(serverUrl);
    sockets.push(rejoinedSocket);

    const ownerUpdatedEvent = once<{
      participant: { id: string; socketId: string; connectionState: 'connected' | 'reconnecting' };
    }>(ownerSocket, 'participant:updated');

    const rejoinAck = await joinRoom(rejoinedSocket, {
      roomId,
      displayName: 'Mira',
      anonymousAuthToken: guestAnonymousToken,
      sessionToken: guestJoinAck.sessionToken
    });

    expect(rejoinAck.participantId).toBe(guestJoinAck.participantId);
    expect(rejoinAck.participants).toHaveLength(2);

    await expect(ownerUpdatedEvent).resolves.toMatchObject({
      participant: {
        id: guestJoinAck.participantId,
        socketId: rejoinedSocket.id,
        connectionState: 'connected'
      }
    });

    const healthResponse = await fetch(`${serverUrl}/health`);
    const health = (await healthResponse.json()) as {
      metrics: { reconnectTimers: number };
    };
    expect(health.metrics.reconnectTimers).toBe(0);
  });

  it('restores the same participant on rejoin with clientSessionId when token is missing', async () => {
    const roomId = nextRoomId();
    const guestAnonymousToken = 'anon-rejoin-token-room-2';
    const ownerSocket = await connectClient(serverUrl);
    const guestSocket = await connectClient(serverUrl);
    sockets.push(ownerSocket, guestSocket);

    await joinRoom(ownerSocket, {
      roomId,
      displayName: 'Alex',
      clientSessionId: 'client-owner-restore-1'
    });
    const guestJoinAck = await joinRoom(guestSocket, {
      roomId,
      displayName: 'Mira',
      anonymousAuthToken: guestAnonymousToken,
      clientSessionId: 'client-guest-restore-1'
    });

    appServer!.io.sockets.sockets.get(guestSocket.id)?.disconnect(true);
    await once(ownerSocket, 'participant:updated');

    const rejoinedSocket = await connectClient(serverUrl);
    sockets.push(rejoinedSocket);

    const ownerUpdatedEvent = once<{
      participant: { id: string; socketId: string; connectionState: 'connected' | 'reconnecting' };
    }>(ownerSocket, 'participant:updated');
    const rejoinAck = await joinRoom(rejoinedSocket, {
      roomId,
      displayName: 'Mira',
      anonymousAuthToken: guestAnonymousToken,
      clientSessionId: 'client-guest-restore-1'
    });

    expect(rejoinAck.participantId).toBe(guestJoinAck.participantId);
    await expect(ownerUpdatedEvent).resolves.toMatchObject({
      participant: {
        id: guestJoinAck.participantId,
        socketId: rejoinedSocket.id,
        connectionState: 'connected'
      }
    });
  });

  it('treats explicit client disconnect as leave, not reconnecting', async () => {
    const roomId = nextRoomId();
    const ownerSocket = await connectClient(serverUrl);
    const guestSocket = await connectClient(serverUrl);
    sockets.push(ownerSocket, guestSocket);

    await joinRoom(ownerSocket, {
      roomId,
      displayName: 'Alex',
      clientSessionId: 'client-owner-disconnect-1'
    });
    const guestJoinAck = await joinRoom(guestSocket, {
      roomId,
      displayName: 'Mira',
      clientSessionId: 'client-guest-disconnect-1'
    });

    const reconnectingEvent = onceWithTimeout(ownerSocket, 'participant:updated');
    const leftEvent = once(ownerSocket, 'participant:left');
    guestSocket.disconnect();

    await expect(reconnectingEvent).resolves.toBeNull();
    await expect(leftEvent).resolves.toMatchObject({
      participantId: guestJoinAck.participantId,
      message: {
        kind: 'system',
        text: 'Mira left the room'
      }
    });
  });

  it('evicts the previous socket from room broadcasts on duplicate session rebind', async () => {
    const roomId = nextRoomId();
    const guestAnonymousToken = 'anon-rebind-token-1';
    const ownerSocket = await connectClient(serverUrl);
    const guestSocket = await connectClient(serverUrl);
    const duplicateSocket = await connectClient(serverUrl);
    sockets.push(ownerSocket, guestSocket, duplicateSocket);

    await joinRoom(ownerSocket, {
      roomId,
      displayName: 'Alex',
      clientSessionId: 'client-owner-rebind-1'
    });
    const guestJoinAck = await joinRoom(guestSocket, {
      roomId,
      displayName: 'Mira',
      anonymousAuthToken: guestAnonymousToken,
      clientSessionId: 'client-guest-rebind-1'
    });

    const evictedEvent = once<{ roomId: string; reason: string }>(guestSocket, 'session:evicted');
    const rebindAck = await joinRoom(duplicateSocket, {
      roomId,
      displayName: 'Mira',
      anonymousAuthToken: guestAnonymousToken,
      sessionToken: guestJoinAck.sessionToken
    });

    expect(rebindAck.participantId).toBe(guestJoinAck.participantId);
    await expect(evictedEvent).resolves.toMatchObject({
      roomId,
      reason: 'SESSION_REBOUND'
    });

    const staleSocketMessage = onceWithTimeout(guestSocket, 'chat:received');
    const reboundSocketMessage = onceWithTimeout(duplicateSocket, 'chat:received');
    ownerSocket.emit('chat:send', { text: 'after-rebind' });

    await expect(staleSocketMessage).resolves.toBeNull();
    await expect(reboundSocketMessage).resolves.toMatchObject({
      message: {
        text: 'after-rebind'
      }
    });
  });

  it('relays signaling messages to the targeted participant', async () => {
    const roomId = nextRoomId();
    const ownerSocket = await connectClient(serverUrl);
    const guestSocket = await connectClient(serverUrl);
    sockets.push(ownerSocket, guestSocket);

    const ownerJoinAck = await joinRoom(ownerSocket, {
      roomId,
      displayName: 'Alex',
      clientSessionId: 'client-owner-5555'
    });
    const guestJoinAck = await joinRoom(guestSocket, {
      roomId,
      displayName: 'Mira',
      clientSessionId: 'client-guest-5555'
    });

    const signalReceived = once<{
      fromParticipantId: string;
      signal: {
        type: 'offer' | 'answer' | 'candidate';
        payload: unknown;
      };
    }>(guestSocket, 'signal:received');

    ownerSocket.emit('signal:send', {
      targetParticipantId: guestJoinAck.participantId,
      signal: {
        type: 'offer',
        payload: { type: 'offer', sdp: 'fake-offer-sdp' }
      }
    });

    await expect(signalReceived).resolves.toEqual({
      fromParticipantId: ownerJoinAck.participantId,
      signal: {
        type: 'offer',
        payload: { type: 'offer', sdp: 'fake-offer-sdp' }
      }
    });
  });

  it('broadcasts chat messages to the whole room', async () => {
    const roomId = nextRoomId();
    const ownerSocket = await connectClient(serverUrl);
    const guestSocket = await connectClient(serverUrl);
    sockets.push(ownerSocket, guestSocket);

    await joinRoom(ownerSocket, {
      roomId,
      displayName: 'Alex',
      clientSessionId: 'client-owner-6666'
    });
    const guestJoinAck = await joinRoom(guestSocket, {
      roomId,
      displayName: 'Mira',
      clientSessionId: 'client-guest-6666'
    });

    const ownerMessage = once<{ message: { authorId: string; authorName: string; text: string; kind: 'user' | 'system' } }>(
      ownerSocket,
      'chat:received'
    );
    const guestMessage = once<{ message: { authorId: string; authorName: string; text: string; kind: 'user' | 'system' } }>(
      guestSocket,
      'chat:received'
    );

    guestSocket.emit('chat:send', { text: 'hello team' });

    await expect(ownerMessage).resolves.toMatchObject({
      message: {
        authorId: guestJoinAck.participantId,
        authorName: 'Mira',
        text: 'hello team',
        kind: 'user'
      }
    });
    await expect(guestMessage).resolves.toMatchObject({
      message: {
        authorId: guestJoinAck.participantId,
        authorName: 'Mira',
        text: 'hello team',
        kind: 'user'
      }
    });
  });

  it('synchronizes speaking state between participants', async () => {
    const roomId = nextRoomId();
    const ownerSocket = await connectClient(serverUrl);
    const guestSocket = await connectClient(serverUrl);
    sockets.push(ownerSocket, guestSocket);

    await joinRoom(ownerSocket, {
      roomId,
      displayName: 'Alex',
      clientSessionId: 'client-owner-speaking-1'
    });
    const guestJoinAck = await joinRoom(guestSocket, {
      roomId,
      displayName: 'Mira',
      clientSessionId: 'client-guest-speaking-1'
    });

    const ownerSeesSpeaking = once<{ participant: { id: string; isSpeaking: boolean } }>(
      ownerSocket,
      'participant:updated'
    );
    guestSocket.emit('participant:speaking-state', { isSpeaking: true });

    await expect(ownerSeesSpeaking).resolves.toMatchObject({
      participant: {
        id: guestJoinAck.participantId,
        isSpeaking: true
      }
    });

    const ownerSeesSilent = once<{ participant: { id: string; isSpeaking: boolean } }>(
      ownerSocket,
      'participant:updated'
    );
    guestSocket.emit('participant:speaking-state', { isSpeaking: false });

    await expect(ownerSeesSilent).resolves.toMatchObject({
      participant: {
        id: guestJoinAck.participantId,
        isSpeaking: false
      }
    });
  });

  it('lets the owner change room policies and enforces chat restrictions for other participants', async () => {
    const roomId = nextRoomId();
    const ownerSocket = await connectClient(serverUrl);
    const guestSocket = await connectClient(serverUrl);
    sockets.push(ownerSocket, guestSocket);

    await joinRoom(ownerSocket, {
      roomId,
      displayName: 'Alex',
      clientSessionId: 'client-owner-7777'
    });
    await joinRoom(guestSocket, {
      roomId,
      displayName: 'Mira',
      clientSessionId: 'client-guest-7777'
    });

    const ownerPolicyEvent = once<{
      policy: {
        allowChat: boolean;
        allowScreenShare: boolean;
        allowSystemAudio: boolean;
      };
    }>(ownerSocket, 'room:policy-updated');
    const guestPolicyEvent = once<{
      policy: {
        allowChat: boolean;
        allowScreenShare: boolean;
        allowSystemAudio: boolean;
      };
    }>(guestSocket, 'room:policy-updated');

    ownerSocket.emit('room:policy', {
      allowChat: false,
      allowScreenShare: false,
      allowSystemAudio: false
    });

    await expect(ownerPolicyEvent).resolves.toEqual({
      policy: {
        allowChat: false,
        allowScreenShare: false,
        allowSystemAudio: false
      }
    });
    await expect(guestPolicyEvent).resolves.toEqual({
      policy: {
        allowChat: false,
        allowScreenShare: false,
        allowSystemAudio: false
      }
    });

    const chatError = once<{ message: string }>(guestSocket, 'chat:error');
    let chatReceived = false;
    ownerSocket.once('chat:received', () => {
      chatReceived = true;
    });

    guestSocket.emit('chat:send', { text: 'blocked message' });

    await expect(chatError).resolves.toEqual({
      message: 'Chat is disabled by the room owner'
    });
    expect(chatReceived).toBe(false);
  });

  it('immediately enforces screen/audio policy and emits aggregated enforcement event', async () => {
    const roomId = nextRoomId();
    const ownerSocket = await connectClient(serverUrl);
    const guestSocket = await connectClient(serverUrl);
    sockets.push(ownerSocket, guestSocket);

    await joinRoom(ownerSocket, {
      roomId,
      displayName: 'Alex',
      clientSessionId: 'client-owner-8888'
    });
    const guestJoinAck = await joinRoom(guestSocket, {
      roomId,
      displayName: 'Mira',
      clientSessionId: 'client-guest-8888'
    });

    await new Promise<void>((resolve, reject) => {
      guestSocket.emit(
        'participant:media-state',
        {
          isScreenSharing: true,
          isSharingAudio: true,
          screenStreamId: 'screen-1'
        },
        (ack: { ok: boolean }) => {
          if (!ack.ok) {
            reject(new Error('expected media-state ack to be ok'));
            return;
          }

          resolve();
        }
      );
    });

    const enforcedEvent = once<{
      policy: { allowChat: boolean; allowScreenShare: boolean; allowSystemAudio: boolean };
      forcedParticipants: Array<{
        id: string;
        isScreenSharing: boolean;
        isSharingAudio: boolean;
        screenStreamId?: string;
      }>;
      message?: { kind: 'system'; text: string };
    }>(ownerSocket, 'room:policy-enforced');
    const forcedParticipantUpdated = once<{
      participant: {
        id: string;
        isScreenSharing: boolean;
        isSharingAudio: boolean;
        screenStreamId?: string;
      };
    }>(guestSocket, 'participant:updated');

    ownerSocket.emit('room:policy', {
      allowChat: false,
      allowScreenShare: false,
      allowSystemAudio: false
    });

    await expect(enforcedEvent).resolves.toMatchObject({
      policy: {
        allowChat: false,
        allowScreenShare: false,
        allowSystemAudio: false
      },
      forcedParticipants: [
        {
          id: guestJoinAck.participantId,
          isScreenSharing: false,
          isSharingAudio: false
        }
      ],
      message: {
        kind: 'system',
        text: 'Chat was disabled by the room owner'
      }
    });

    await expect(forcedParticipantUpdated).resolves.toMatchObject({
      participant: {
        id: guestJoinAck.participantId,
        isScreenSharing: false,
        isSharingAudio: false
      }
    });
  });

  it('rejects invalid and oversized signaling payloads without relaying them', async () => {
    const roomId = nextRoomId();
    const ownerSocket = await connectClient(serverUrl);
    const guestSocket = await connectClient(serverUrl);
    sockets.push(ownerSocket, guestSocket);

    const ownerJoinAck = await joinRoom(ownerSocket, {
      roomId,
      displayName: 'Alex',
      clientSessionId: 'client-owner-9991'
    });
    const guestJoinAck = await joinRoom(guestSocket, {
      roomId,
      displayName: 'Mira',
      clientSessionId: 'client-guest-9991'
    });

    const invalidSignalError = once<{ code: string; message: string }>(ownerSocket, 'signal:error');
    ownerSocket.emit('signal:send', {
      targetParticipantId: guestJoinAck.participantId,
      signal: {
        type: 'offer',
        payload: {}
      }
    });

    await expect(invalidSignalError).resolves.toMatchObject({
      code: 'INVALID_SIGNAL_PAYLOAD'
    });
    await expect(onceWithTimeout(guestSocket, 'signal:received')).resolves.toBeNull();

    const oversizedSignalError = once<{ code: string; message: string }>(ownerSocket, 'signal:error');
    ownerSocket.emit('signal:send', {
      targetParticipantId: guestJoinAck.participantId,
      signal: {
        type: 'offer',
        payload: {
          sdp: `v=0\r\n${'x'.repeat(70_000)}`
        }
      }
    });

    await expect(oversizedSignalError).resolves.toMatchObject({
      code: 'INVALID_SIGNAL_PAYLOAD'
    });
    await expect(onceWithTimeout(guestSocket, 'signal:received')).resolves.toBeNull();

    const validSignalReceived = once<{
      fromParticipantId: string;
      signal: { type: 'offer'; payload: { sdp: string } };
    }>(guestSocket, 'signal:received');
    ownerSocket.emit('signal:send', {
      targetParticipantId: guestJoinAck.participantId,
      signal: {
        type: 'offer',
        payload: { type: 'offer', sdp: 'v=0\r\nok' }
      }
    });

    await expect(validSignalReceived).resolves.toEqual({
      fromParticipantId: ownerJoinAck.participantId,
      signal: {
        type: 'offer',
        payload: { type: 'offer', sdp: 'v=0\r\nok' }
      }
    });
  });

  it('applies chat rate limiting with soft deny and keeps socket connected', async () => {
    const roomId = nextRoomId();
    const ownerSocket = await connectClient(serverUrl);
    const guestSocket = await connectClient(serverUrl);
    sockets.push(ownerSocket, guestSocket);

    await joinRoom(ownerSocket, {
      roomId,
      displayName: 'Alex',
      clientSessionId: 'client-owner-9992'
    });
    await joinRoom(guestSocket, {
      roomId,
      displayName: 'Mira',
      clientSessionId: 'client-guest-9992'
    });

    let rateLimitError: { code: string; message: string } | null = null;
    guestSocket.on('chat:error', (payload: { code?: string; message: string }) => {
      if (payload.code === 'RATE_LIMITED') {
        rateLimitError = { code: payload.code, message: payload.message };
      }
    });

    for (let i = 0; i < 35; i += 1) {
      guestSocket.emit('chat:send', { text: `spam-${i}` });
    }

    await new Promise((resolve) => setTimeout(resolve, 400));

    expect(rateLimitError).toMatchObject({
      code: 'RATE_LIMITED'
    });
    expect(guestSocket.connected).toBe(true);
  });

  it('cleans up empty rooms and exposes observability counters in health', async () => {
    const roomId = nextRoomId();
    const ownerSocket = await connectClient(serverUrl);
    const guestSocket = await connectClient(serverUrl);
    sockets.push(ownerSocket, guestSocket);

    await joinRoom(ownerSocket, {
      roomId,
      displayName: 'Alex',
      clientSessionId: 'client-owner-9993'
    });
    await joinRoom(guestSocket, {
      roomId,
      displayName: 'Mira',
      clientSessionId: 'client-guest-9993'
    });

    guestSocket.emit('chat:send', { text: 'hello' });
    await once(ownerSocket, 'chat:received');

    const guestLeft = once(ownerSocket, 'participant:left');
    guestSocket.emit('room:leave');
    await guestLeft;

    ownerSocket.emit('room:leave');
    await new Promise((resolve) => setTimeout(resolve, 150));

    const healthResponse = await fetch(`${serverUrl}/health`);
    const health = (await healthResponse.json()) as {
      ok: boolean;
      rooms: number;
      status: 'ok' | 'degraded';
      issues: string[];
      metrics: Record<string, number>;
      memory: Record<string, number>;
    };

    expect(health.ok).toBe(true);
    expect(health.rooms).toBe(0);
    expect(health.status).toBe('ok');
    expect(health.issues).toEqual([]);
    expect(health.metrics.activeRooms).toBe(0);
    expect(health.metrics.reconnectTimers).toBe(0);
    expect(health.metrics.chatEvents).toBeGreaterThanOrEqual(1);
    expect(health.memory.heapUsed).toBeGreaterThan(0);
  });

  it('returns degraded health when critical realtime failures are observed', async () => {
    const roomId = nextRoomId();
    const ownerSocket = await connectClient(serverUrl);
    const guestSocket = await connectClient(serverUrl);
    sockets.push(ownerSocket, guestSocket);

    await joinRoom(ownerSocket, {
      roomId,
      displayName: 'Alex',
      clientSessionId: 'client-owner-health-1'
    });
    const guestJoinAck = await joinRoom(guestSocket, {
      roomId,
      displayName: 'Mira',
      clientSessionId: 'client-guest-health-1'
    });

    ownerSocket.emit('signal:send', {
      targetParticipantId: guestJoinAck.participantId,
      signal: {
        type: 'offer',
        payload: {}
      }
    });
    await once(ownerSocket, 'signal:error');

    const healthResponse = await fetch(`${serverUrl}/health`);
    const health = (await healthResponse.json()) as {
      status: 'ok' | 'degraded';
      issues: string[];
      metrics: Record<string, number>;
    };

    expect(health.status).toBe('degraded');
    expect(health.issues).toContain('signaling-failures');
    expect(health.metrics.signalingFailures).toBeGreaterThanOrEqual(1);
  });
});
