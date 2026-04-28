import type { KeyValueStore } from '../storage/contracts.js';
import { createInMemoryKeyValueStore } from '../storage/in-memory.js';

export type ClientSessionStore = KeyValueStore<string, string>;

type CreateClientSessionMappingOptions = {
  clientSessionStore?: ClientSessionStore;
};

const toKey = (roomId: string, clientSessionId: string) => `${roomId}:${clientSessionId}`;

export const createClientSessionMapping = (options: CreateClientSessionMappingOptions = {}) => {
  const clientSessions = options.clientSessionStore ?? createInMemoryKeyValueStore<string, string>();

  return {
    async bindClientSession(roomId: string, clientSessionId: string, participantId: string) {
      await clientSessions.set(toKey(roomId, clientSessionId), participantId);
    },
    async getParticipantId(roomId: string, clientSessionId: string) {
      return clientSessions.get(toKey(roomId, clientSessionId));
    },
    async unbindClientSession(roomId: string, clientSessionId: string) {
      await clientSessions.delete(toKey(roomId, clientSessionId));
    }
  };
};

export type ClientSessionMapping = ReturnType<typeof createClientSessionMapping>;
