import cors from 'cors';
import express from 'express';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Server, type Socket } from 'socket.io';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { createRoomState, type ChatMessage, type RoomState } from './domain/room-state.js';

const joinRoomSchema = z.object({
  roomId: z.string().trim().min(2).max(64),
  displayName: z.string().trim().min(1).max(48),
  clientSessionId: z.string().trim().min(8).max(128).optional()
});

const signalSchema = z.object({
  targetParticipantId: z.string(),
  signal: z.object({
    type: z.enum(['offer', 'answer', 'candidate']),
    payload: z.unknown()
  })
});

const mediaStateSchema = z.object({
  isCameraOn: z.boolean().optional(),
  isMicOn: z.boolean().optional(),
  isScreenSharing: z.boolean().optional(),
  isSharingAudio: z.boolean().optional(),
  cameraStreamId: z.string().optional(),
  screenStreamId: z.string().optional()
});

const chatMessageSchema = z.object({
  text: z.string().trim().min(1).max(500)
});

const policySchema = z.object({
  allowChat: z.boolean().optional(),
  allowScreenShare: z.boolean().optional(),
  allowSystemAudio: z.boolean().optional()
});

type JoinAck =
  | {
      ok: true;
      participantId: string;
      clientSessionId: string;
      roomId: string;
      participants: ReturnType<RoomState['getParticipants']>;
      chatMessages: ChatMessage[];
      policy: ReturnType<RoomState['getPolicy']>;
    }
  | { ok: false; error: string };

type MediaStateAck =
  | {
      ok: true;
      participant: ReturnType<RoomState['getParticipants']>[number];
    }
  | { ok: false; error: string };

type SocketSession = {
  roomId: string;
  participantId: string;
};

const rooms = new Map<string, RoomState>();
const socketSessions = new Map<string, SocketSession>();
const participantRemovalTimers = new Map<string, ReturnType<typeof setTimeout>>();
const RECONNECT_GRACE_MS = 60_000;

const createId = (prefix: string) => `${prefix}_${Math.random().toString(36).slice(2, 10)}`;

const getOrCreateRoom = (roomId: string) => {
  const existing = rooms.get(roomId);
  if (existing) {
    return existing;
  }

  const room = createRoomState(roomId);
  rooms.set(roomId, room);
  return room;
};

const removeRoomIfEmpty = (roomId: string) => {
  const room = rooms.get(roomId);
  if (room?.isEmpty()) {
    rooms.delete(roomId);
  }
};

const cancelParticipantRemoval = (participantId: string) => {
  const timer = participantRemovalTimers.get(participantId);
  if (!timer) {
    return;
  }

  clearTimeout(timer);
  participantRemovalTimers.delete(participantId);
};

const getSession = (socket: Socket) => {
  const session = socketSessions.get(socket.id);
  if (!session) {
    throw new Error('Socket is not joined to a room');
  }

  return session;
};

const createSystemMessage = (authorName: string, text: string): ChatMessage => ({
  id: createId('msg'),
  authorId: 'system',
  authorName,
  text,
  kind: 'system',
  createdAt: Date.now()
});

export const createAppServer = () => {
  const app = express();
  const currentDir = dirname(fileURLToPath(import.meta.url));
  const webDistDir = join(currentDir, '../../web/dist');

  app.use(cors({ origin: '*' }));
  app.use(express.json());

  app.get('/health', (_req, res) => {
    res.json({
      ok: true,
      rooms: rooms.size
    });
  });

  if (existsSync(webDistDir)) {
    app.use(express.static(webDistDir));
    app.get(/^(?!\/socket\.io\/|\/health).*/, (_req, res) => {
      res.sendFile(join(webDistDir, 'index.html'));
    });
  }

  const httpServer = createServer(app);

  const io = new Server(httpServer, {
    cors: {
      origin: '*'
    }
  });

  const finalizeParticipantLeave = (roomId: string, participantId: string, participantName: string) => {
    const room = rooms.get(roomId);
    if (!room) {
      removeRoomIfEmpty(roomId);
      return;
    }

    const didLeave = room.leave(participantId);
    cancelParticipantRemoval(participantId);

    if (!didLeave) {
      removeRoomIfEmpty(roomId);
      return;
    }

    const systemMessage = room.addChatMessage(
      createSystemMessage('System', `${participantName} left the room`)
    );

    io.to(roomId).emit('participant:left', {
      participantId,
      participants: room.getParticipants(),
      message: systemMessage
    });

    removeRoomIfEmpty(roomId);
  };

  const scheduleParticipantRemoval = (roomId: string, participantId: string, participantName: string) => {
    cancelParticipantRemoval(participantId);
    const timer = setTimeout(() => {
      const room = rooms.get(roomId);
      const participant = room?.getParticipant(participantId);
      if (!room || !participant || participant.connectionState !== 'reconnecting') {
        cancelParticipantRemoval(participantId);
        return;
      }

      finalizeParticipantLeave(roomId, participantId, participant.displayName || participantName);
    }, RECONNECT_GRACE_MS);

    participantRemovalTimers.set(participantId, timer);
  };

  io.on('connection', (socket) => {
    console.log('[socket] connected', socket.id);
    socket.on('room:join', (payload: unknown, ack?: (response: JoinAck) => void) => {
      const parsed = joinRoomSchema.safeParse(payload);
      if (!parsed.success) {
        ack?.({ ok: false, error: 'Invalid join payload' });
        return;
      }

      const { roomId, displayName } = parsed.data;
      const clientSessionId = parsed.data.clientSessionId?.trim() || `legacy_${roomId}_${socket.id}`;
      const room = getOrCreateRoom(roomId);
      const joinResult = room.join({
        socketId: socket.id,
        displayName,
        clientSessionId
      });
      const participant = joinResult.participant;

      socket.join(roomId);
      socketSessions.set(socket.id, {
        roomId,
        participantId: participant.id
      });
      cancelParticipantRemoval(participant.id);

      if (!joinResult.isRejoin) {
        const systemMessage = room.addChatMessage(
          createSystemMessage('System', `${participant.displayName} joined the room`)
        );

        socket.to(roomId).emit('participant:joined', {
          participant,
          message: systemMessage
        });
      } else {
        socket.to(roomId).emit('participant:updated', {
          participant
        });
      }

      const participantSnapshot = room.getParticipants();
      console.log('[room] joined', {
        roomId,
        participantId: participant.id,
        displayName: participant.displayName,
        socketId: socket.id,
        participantsInRoom: participantSnapshot.map((item) => ({
          id: item.id,
          displayName: item.displayName,
          role: item.role
        }))
      });

      ack?.({
        ok: true,
        participantId: participant.id,
        clientSessionId,
        roomId,
        participants: participantSnapshot,
        chatMessages: room.getChatMessages(),
        policy: room.getPolicy()
      });
    });

    socket.on('signal:send', (payload: unknown) => {
      const parsed = signalSchema.safeParse(payload);
      if (!parsed.success) {
        return;
      }

      const session = socketSessions.get(socket.id);
      if (!session) {
        return;
      }

      const room = rooms.get(session.roomId);
      const sourceParticipant = room?.getParticipant(session.participantId);
      const targetParticipant = room?.getParticipant(parsed.data.targetParticipantId);

      if (!room || !sourceParticipant || !targetParticipant) {
        return;
      }

      io.to(targetParticipant.socketId).emit('signal:received', {
        fromParticipantId: sourceParticipant.id,
        signal: parsed.data.signal
      });
    });

    socket.on('participant:media-state', (payload: unknown, ack?: (response: MediaStateAck) => void) => {
      const parsed = mediaStateSchema.safeParse(payload);
      if (!parsed.success) {
        ack?.({ ok: false, error: 'Invalid media state payload' });
        return;
      }

      const session = socketSessions.get(socket.id);
      if (!session) {
        ack?.({ ok: false, error: 'Socket is not joined to a room' });
        return;
      }

      const room = rooms.get(session.roomId);
      const participant = room?.getParticipant(session.participantId);
      if (!room || !participant) {
        ack?.({ ok: false, error: 'Participant not found' });
        return;
      }

      const policy = room.getPolicy();
      const patch = { ...parsed.data };

      if (participant.role !== 'owner' && policy.allowScreenShare === false) {
        patch.isScreenSharing = false;
        patch.screenStreamId = undefined;
      }

      if (participant.role !== 'owner' && policy.allowSystemAudio === false) {
        patch.isSharingAudio = false;
      }

      const updated = room.updateParticipantMedia(session.participantId, patch);
      if (!updated) {
        ack?.({ ok: false, error: 'Failed to update participant media' });
        return;
      }

      socket.to(session.roomId).emit('participant:updated', {
        participant: updated
      });
      ack?.({
        ok: true,
        participant: updated
      });
    });

    socket.on('chat:send', (payload: unknown) => {
      const parsed = chatMessageSchema.safeParse(payload);
      if (!parsed.success) {
        return;
      }

      const session = socketSessions.get(socket.id);
      if (!session) {
        return;
      }

      const room = rooms.get(session.roomId);
      const author = room?.getParticipant(session.participantId);
      if (!room || !author) {
        return;
      }

      if (!room.getPolicy().allowChat) {
        socket.emit('chat:error', {
          message: 'Chat is disabled by the room owner'
        });
        return;
      }

      const message = room.addChatMessage({
        id: createId('msg'),
        authorId: author.id,
        authorName: author.displayName,
        text: parsed.data.text,
        kind: 'user',
        createdAt: Date.now()
      });

      io.to(session.roomId).emit('chat:received', {
        message
      });
    });

    socket.on('room:policy', (payload: unknown) => {
      const parsed = policySchema.safeParse(payload);
      if (!parsed.success) {
        return;
      }

      const session = socketSessions.get(socket.id);
      if (!session) {
        return;
      }

      const room = rooms.get(session.roomId);
      const participant = room?.getParticipant(session.participantId);
      if (!room || !participant || participant.role !== 'owner') {
        return;
      }

      const updatedPolicy = room.updatePolicy(parsed.data);
      io.to(session.roomId).emit('room:policy-updated', {
        policy: updatedPolicy
      });
    });

    socket.on('room:leave', () => {
      const session = socketSessions.get(socket.id);
      if (!session) {
        return;
      }

      socketSessions.delete(socket.id);
      const room = rooms.get(session.roomId);
      const participant = room?.getParticipant(session.participantId);
      if (!room || !participant) {
        removeRoomIfEmpty(session.roomId);
        return;
      }

      finalizeParticipantLeave(session.roomId, session.participantId, participant.displayName);
    });

    socket.on('disconnect', (reason) => {
      const session = socketSessions.get(socket.id);
      console.log('[socket] disconnected', socket.id, reason);
      if (!session) {
        return;
      }

      socketSessions.delete(socket.id);

      const room = rooms.get(session.roomId);
      const participant = room?.getParticipant(session.participantId);
      if (!room || !participant) {
        removeRoomIfEmpty(session.roomId);
        return;
      }

      const updated = room.updateParticipantConnection(session.participantId, 'reconnecting');
      if (!updated) {
        removeRoomIfEmpty(session.roomId);
        return;
      }

      io.to(session.roomId).emit('participant:updated', {
        participant: updated
      });
      scheduleParticipantRemoval(session.roomId, session.participantId, participant.displayName);
    });
  });

  return { app, httpServer, io };
};
