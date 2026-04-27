import type { KeyValueStore, ListStore, SingletonStore } from '../storage/contracts.js';
import {
  createInMemoryKeyValueStore,
  createInMemoryListStore,
  createInMemorySingletonStore
} from '../storage/in-memory.js';

export type ParticipantRole = 'owner' | 'participant';

export type ParticipantMediaState = {
  isCameraOn: boolean;
  isMicOn: boolean;
  isSpeaking: boolean;
  isScreenSharing: boolean;
  isSharingAudio: boolean;
  cameraStreamId?: string;
  screenStreamId?: string;
};

export type ParticipantSnapshot = ParticipantMediaState & {
  id: string;
  socketId: string;
  displayName: string;
  role: ParticipantRole;
  joinedAt: number;
  isPinned: boolean;
  connectionState: 'connected' | 'reconnecting';
};

export type ChatMessage = {
  id: string;
  authorId: string;
  authorName: string;
  text: string;
  kind: 'user' | 'system';
  createdAt: number;
};

export type RoomPolicy = {
  allowChat: boolean;
  allowScreenShare: boolean;
  allowSystemAudio: boolean;
};

export type JoinPayload = {
  socketId: string;
  displayName: string;
};

export type InternalParticipant = ParticipantSnapshot;

export type ParticipantStore = KeyValueStore<string, InternalParticipant>;
export type ChatMessageStore = ListStore<ChatMessage>;
export type RoomPolicyStore = SingletonStore<RoomPolicy>;

export type JoinResult = {
  participant: ParticipantSnapshot;
  isRejoin: boolean;
};

export type RoomState = {
  roomId: string;
  join(payload: JoinPayload): Promise<JoinResult>;
  reconnect(participantId: string, payload: JoinPayload): Promise<ParticipantSnapshot | undefined>;
  leave(participantId: string): Promise<boolean>;
  updateParticipantMedia(
    participantId: string,
    patch: Partial<ParticipantMediaState>
  ): Promise<ParticipantSnapshot | undefined>;
  updateParticipantConnection(
    participantId: string,
    connectionState: ParticipantSnapshot['connectionState']
  ): Promise<ParticipantSnapshot | undefined>;
  updateParticipantSocket(
    participantId: string,
    socketId: string
  ): Promise<ParticipantSnapshot | undefined>;
  addChatMessage(message: ChatMessage): Promise<ChatMessage>;
  updatePolicy(patch: Partial<RoomPolicy>): Promise<RoomPolicy>;
  getPolicy(): Promise<RoomPolicy>;
  getParticipant(participantId: string): Promise<ParticipantSnapshot | undefined>;
  getParticipantBySocketId(socketId: string): Promise<ParticipantSnapshot | undefined>;
  getParticipants(): Promise<ParticipantSnapshot[]>;
  getChatMessages(): Promise<ChatMessage[]>;
  isEmpty(): Promise<boolean>;
};

const defaultPolicy: RoomPolicy = {
  allowChat: true,
  allowScreenShare: true,
  allowSystemAudio: true
};

const defaultMediaState: ParticipantMediaState = {
  isCameraOn: false,
  isMicOn: false,
  isSpeaking: false,
  isScreenSharing: false,
  isSharingAudio: false
};

const createParticipantId = () => `p_${Math.random().toString(36).slice(2, 10)}`;

type RoomStateStorageOptions = {
  participantStore?: ParticipantStore;
  chatMessageStore?: ChatMessageStore;
  roomPolicyStore?: RoomPolicyStore;
};

export const createRoomState = (roomId: string, storage: RoomStateStorageOptions = {}): RoomState => {
  const participants =
    storage.participantStore ?? createInMemoryKeyValueStore<string, InternalParticipant>();
  const chatMessages = storage.chatMessageStore ?? createInMemoryListStore<ChatMessage>();
  // Policy is storage-backed so a future shared adapter can replace the in-memory implementation
  // without rewriting room orchestration. Broader room metadata can follow the same pattern later.
  const roomPolicyStore = storage.roomPolicyStore ?? createInMemorySingletonStore<RoomPolicy>();

  const getStoredPolicy = async () => {
    const existingPolicy = await roomPolicyStore.get();
    if (existingPolicy) {
      return existingPolicy;
    }

    const seededPolicy = { ...defaultPolicy };
    await roomPolicyStore.set(seededPolicy);
    return seededPolicy;
  };

  const toPublicParticipant = (participant: InternalParticipant): ParticipantSnapshot => ({
    id: participant.id,
    socketId: participant.socketId,
    displayName: participant.displayName,
    role: participant.role,
    joinedAt: participant.joinedAt,
    isPinned: participant.isPinned,
    connectionState: participant.connectionState,
    isCameraOn: participant.isCameraOn,
    isMicOn: participant.isMicOn,
    isSpeaking: participant.isSpeaking,
    isScreenSharing: participant.isScreenSharing,
    isSharingAudio: participant.isSharingAudio,
    cameraStreamId: participant.cameraStreamId,
    screenStreamId: participant.screenStreamId
  });

  const reassignOwnerIfNeeded = async () => {
    const values = await participants.values();
    const currentOwner = values.find((participant) => participant.role === 'owner');

    if (currentOwner || values.length === 0) {
      return;
    }

    const nextOwner = values.sort((a, b) => a.joinedAt - b.joinedAt)[0];
    if (nextOwner) {
      await participants.set(nextOwner.id, { ...nextOwner, role: 'owner' });
    }
  };

  return {
    roomId,
    async join(payload: JoinPayload) {
      const participantCount = await participants.size();
      const participant: InternalParticipant = {
        id: createParticipantId(),
        socketId: payload.socketId,
        displayName: payload.displayName.trim() || 'Guest',
        role: participantCount === 0 ? 'owner' : 'participant',
        joinedAt: Date.now(),
        isPinned: false,
        connectionState: 'connected',
        ...defaultMediaState
      };

      await participants.set(participant.id, participant);
      return {
        participant: toPublicParticipant(participant),
        isRejoin: false
      };
    },
    async reconnect(participantId: string, payload: JoinPayload) {
      const participant = await participants.get(participantId);
      if (!participant) {
        return undefined;
      }

      const updated: InternalParticipant = {
        ...participant,
        socketId: payload.socketId,
        displayName: payload.displayName.trim() || participant.displayName,
        connectionState: 'connected'
      };

      await participants.set(updated.id, updated);
      return toPublicParticipant(updated);
    },
    async leave(participantId: string) {
      const didDelete = await participants.delete(participantId);
      if (didDelete) {
        await reassignOwnerIfNeeded();
      }

      return didDelete;
    },
    async updateParticipantMedia(participantId: string, patch: Partial<ParticipantMediaState>) {
      const participant = await participants.get(participantId);
      if (!participant) {
        return undefined;
      }

      const updated = {
        ...participant,
        ...patch
      };

      await participants.set(participantId, updated);
      return toPublicParticipant(updated);
    },
    async updateParticipantConnection(
      participantId: string,
      connectionState: ParticipantSnapshot['connectionState']
    ) {
      const participant = await participants.get(participantId);
      if (!participant) {
        return undefined;
      }

      const updated = {
        ...participant,
        connectionState
      };

      await participants.set(participantId, updated);
      return toPublicParticipant(updated);
    },
    async updateParticipantSocket(participantId: string, socketId: string) {
      const participant = await participants.get(participantId);
      if (!participant) {
        return undefined;
      }

      const updated = {
        ...participant,
        socketId
      };

      await participants.set(participantId, updated);
      return toPublicParticipant(updated);
    },
    async addChatMessage(message: ChatMessage) {
      await chatMessages.append(message);
      return message;
    },
    async updatePolicy(patch: Partial<RoomPolicy>) {
      const policy = {
        ...(await getStoredPolicy()),
        ...patch
      };
      await roomPolicyStore.set(policy);

      return policy;
    },
    async getPolicy() {
      return { ...(await getStoredPolicy()) };
    },
    async getParticipant(participantId: string) {
      const participant = await participants.get(participantId);
      return participant ? toPublicParticipant(participant) : undefined;
    },
    async getParticipantBySocketId(socketId: string) {
      const values = await participants.values();
      const participant = values.find((item) => item.socketId === socketId);
      return participant ? toPublicParticipant(participant) : undefined;
    },
    async getParticipants() {
      const values = await participants.values();
      return values.sort((a, b) => a.joinedAt - b.joinedAt).map(toPublicParticipant);
    },
    async getChatMessages() {
      return chatMessages.list();
    },
    async isEmpty() {
      return (await participants.size()) === 0;
    }
  };
};
