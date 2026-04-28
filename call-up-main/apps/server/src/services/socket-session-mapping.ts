import type { KeyValueStore } from '../storage/contracts.js';
import { createInMemoryKeyValueStore } from '../storage/in-memory.js';

export type SocketSession = {
  roomId: string;
  participantId: string;
};

export type ParticipantEndpoint = {
  serverInstanceId: string;
  transportSocketId: string;
};

export type SocketSessionStore = KeyValueStore<string, SocketSession>;
export type ParticipantEndpointStore = KeyValueStore<string, ParticipantEndpoint>;

type BindSocketSessionResult = {
  previousSocketSession?: SocketSession;
  replacedSocketId?: string;
  replacedSocketSession?: SocketSession;
};

type CreateSocketSessionMappingOptions = {
  serverInstanceId: string;
  socketSessionStore?: SocketSessionStore;
  participantEndpointStore?: ParticipantEndpointStore;
};

export const createSocketSessionMapping = (
  options: CreateSocketSessionMappingOptions
) => {
  const socketSessions =
    options.socketSessionStore ?? createInMemoryKeyValueStore<string, SocketSession>();
  const participantEndpoints =
    options.participantEndpointStore ??
    createInMemoryKeyValueStore<string, ParticipantEndpoint>();

  return {
    async bindSocketSession(socketId: string, session: SocketSession): Promise<BindSocketSessionResult> {
      const existingSocketSession = await socketSessions.get(socketId);
      if (existingSocketSession && existingSocketSession.participantId !== session.participantId) {
        const existingEndpoint = await participantEndpoints.get(existingSocketSession.participantId);
        if (existingEndpoint?.transportSocketId === socketId) {
          await participantEndpoints.delete(existingSocketSession.participantId);
        }
      }

      let replacedSocketId: string | undefined;
      let replacedSocketSession: SocketSession | undefined;
      const existingEndpointForParticipant = await participantEndpoints.get(session.participantId);
      if (
        existingEndpointForParticipant &&
        existingEndpointForParticipant.transportSocketId !== socketId
      ) {
        replacedSocketId = existingEndpointForParticipant.transportSocketId;
        replacedSocketSession = await socketSessions.get(replacedSocketId);
        await socketSessions.delete(replacedSocketId);
      }

      await socketSessions.set(socketId, session);
      await participantEndpoints.set(session.participantId, {
        serverInstanceId: options.serverInstanceId,
        transportSocketId: socketId
      });

      return {
        previousSocketSession: existingSocketSession,
        replacedSocketId,
        replacedSocketSession
      };
    },
    async getSocketSession(socketId: string) {
      return socketSessions.get(socketId);
    },
    async unbindSocketSession(socketId: string) {
      const session = await socketSessions.get(socketId);
      if (!session) {
        return undefined;
      }

      await socketSessions.delete(socketId);
      const endpoint = await participantEndpoints.get(session.participantId);
      if (endpoint?.transportSocketId === socketId) {
        await participantEndpoints.delete(session.participantId);
      }

      return session;
    },
    async getParticipantEndpoint(participantId: string) {
      return participantEndpoints.get(participantId);
    },
    async clearParticipantEndpoint(participantId: string) {
      await participantEndpoints.delete(participantId);
    },
    async getActiveSocketSessionCount() {
      return socketSessions.size();
    },
    async getActiveParticipantEndpointCount() {
      return participantEndpoints.size();
    }
  };
};

export type SocketSessionMapping = ReturnType<typeof createSocketSessionMapping>;
