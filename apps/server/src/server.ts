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
  displayName: z.string().trim().min(1).max(48)
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
      roomId: string;
      participants: ReturnType<RoomState['getParticipants']>;
      chatMessages: ChatMessage[];
      policy: ReturnType<RoomState['getPolicy']>;
    }
  | { ok: false; error: string };

type SocketSession = {
  roomId: string;
  participantId: string;
};

const rooms = new Map<string, RoomState>();
const socketSessions = new Map<string, SocketSession>();

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

  io.on('connection', (socket) => {
    console.log('[socket] connected', socket.id);
    socket.on('room:join', (payload: unknown, ack?: (response: JoinAck) => void) => {
      const parsed = joinRoomSchema.safeParse(payload);
      if (!parsed.success) {
        ack?.({ ok: false, error: 'Invalid join payload' });
        return;
      }

      const { roomId, displayName } = parsed.data;
      const room = getOrCreateRoom(roomId);
      const participant = room.join({
        socketId: socket.id,
        displayName
      });

      socket.join(roomId);
      socketSessions.set(socket.id, {
        roomId,
        participantId: participant.id
      });

      const systemMessage = room.addChatMessage(
        createSystemMessage('System', `${participant.displayName} joined the room`)
      );

      socket.to(roomId).emit('participant:joined', {
        participant,
        message: systemMessage
      });

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

    socket.on('participant:media-state', (payload: unknown) => {
      const parsed = mediaStateSchema.safeParse(payload);
      if (!parsed.success) {
        return;
      }

      const session = socketSessions.get(socket.id);
      if (!session) {
        return;
      }

      const room = rooms.get(session.roomId);
      const participant = room?.getParticipant(session.participantId);
      if (!room || !participant) {
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
        return;
      }

      io.to(session.roomId).emit('participant:updated', {
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

    socket.on('disconnect', (reason) => {
      const session = socketSessions.get(socket.id);
      console.log('[socket] disconnected', socket.id, reason);
      if (!session) {
        return;
      }

      socketSessions.delete(socket.id);

      const room = rooms.get(session.roomId);
      const participant = room?.getParticipant(session.participantId);
      const participantName = participant?.displayName ?? 'Guest';
      const didLeave = room?.leave(session.participantId);

      if (!room || !didLeave) {
        removeRoomIfEmpty(session.roomId);
        return;
      }

      const systemMessage = room.addChatMessage(
        createSystemMessage('System', `${participantName} left the room`)
      );

      io.to(session.roomId).emit('participant:left', {
        participantId: session.participantId,
        participants: room.getParticipants(),
        message: systemMessage
      });

      removeRoomIfEmpty(session.roomId);
    });
  });

  return { app, httpServer, io };
};
