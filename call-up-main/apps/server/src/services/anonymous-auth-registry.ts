import type { KeyValueStore } from '../storage/contracts.js';
import { createInMemoryKeyValueStore } from '../storage/in-memory.js';

export type AnonymousAuthBinding = {
  roomId: string;
  participantId: string;
};

export type AnonymousAuthStore = KeyValueStore<string, AnonymousAuthBinding>;
export type ParticipantToAnonymousTokenStore = KeyValueStore<string, string>;

type CreateAnonymousAuthRegistryOptions = {
  bindingStore?: AnonymousAuthStore;
  participantToTokenStore?: ParticipantToAnonymousTokenStore;
};

export const createAnonymousAuthRegistry = (options: CreateAnonymousAuthRegistryOptions = {}) => {
  const bindings = options.bindingStore ?? createInMemoryKeyValueStore<string, AnonymousAuthBinding>();
  const participantToToken =
    options.participantToTokenStore ?? createInMemoryKeyValueStore<string, string>();

  return {
    async getBinding(token: string) {
      return bindings.get(token);
    },
    async bindTokenToParticipant(token: string, binding: AnonymousAuthBinding) {
      await bindings.set(token, binding);
      await participantToToken.set(binding.participantId, token);
    },
    async getTokenForParticipant(participantId: string) {
      return participantToToken.get(participantId);
    },
    async unbindParticipant(participantId: string) {
      const token = await participantToToken.get(participantId);
      if (!token) {
        return;
      }
      await participantToToken.delete(participantId);
      const binding = await bindings.get(token);
      if (binding?.participantId === participantId) {
        await bindings.delete(token);
      }
    }
  };
};

export type AnonymousAuthRegistry = ReturnType<typeof createAnonymousAuthRegistry>;
