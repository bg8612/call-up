export type ParticipantRole = 'owner' | 'participant';

export type ParticipantMediaState = {
  isCameraOn: boolean;
  isMicOn: boolean;
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

const defaultPolicy: RoomPolicy = {
  allowChat: true,
  allowScreenShare: true,
  allowSystemAudio: true
};

const defaultMediaState: ParticipantMediaState = {
  isCameraOn: false,
  isMicOn: false,
  isScreenSharing: false,
  isSharingAudio: false
};

const createParticipantId = () => `p_${Math.random().toString(36).slice(2, 10)}`;

export const createRoomState = (roomId: string) => {
  const participants = new Map<string, ParticipantSnapshot>();
  const chatMessages: ChatMessage[] = [];
  let policy: RoomPolicy = { ...defaultPolicy };

  const reassignOwnerIfNeeded = () => {
    const currentOwner = [...participants.values()].find((participant) => participant.role === 'owner');

    if (currentOwner || participants.size === 0) {
      return;
    }

    const nextOwner = [...participants.values()].sort((a, b) => a.joinedAt - b.joinedAt)[0];
    if (nextOwner) {
      participants.set(nextOwner.id, { ...nextOwner, role: 'owner' });
    }
  };

  return {
    roomId,
    join(payload: JoinPayload) {
      const participant: ParticipantSnapshot = {
        id: createParticipantId(),
        socketId: payload.socketId,
        displayName: payload.displayName.trim() || 'Guest',
        role: participants.size === 0 ? 'owner' : 'participant',
        joinedAt: Date.now(),
        isPinned: false,
        connectionState: 'connected',
        ...defaultMediaState
      };

      participants.set(participant.id, participant);
      return participant;
    },
    leave(participantId: string) {
      const didDelete = participants.delete(participantId);
      if (didDelete) {
        reassignOwnerIfNeeded();
      }

      return didDelete;
    },
    updateParticipantMedia(participantId: string, patch: Partial<ParticipantMediaState>) {
      const participant = participants.get(participantId);
      if (!participant) {
        return undefined;
      }

      const updated = {
        ...participant,
        ...patch
      };

      participants.set(participantId, updated);
      return updated;
    },
    updateParticipantConnection(participantId: string, connectionState: ParticipantSnapshot['connectionState']) {
      const participant = participants.get(participantId);
      if (!participant) {
        return undefined;
      }

      const updated = {
        ...participant,
        connectionState
      };

      participants.set(participantId, updated);
      return updated;
    },
    addChatMessage(message: ChatMessage) {
      chatMessages.push(message);
      return message;
    },
    updatePolicy(patch: Partial<RoomPolicy>) {
      policy = {
        ...policy,
        ...patch
      };

      return policy;
    },
    getPolicy() {
      return { ...policy };
    },
    getParticipant(participantId: string) {
      return participants.get(participantId);
    },
    getParticipantBySocketId(socketId: string) {
      return [...participants.values()].find((participant) => participant.socketId === socketId);
    },
    getParticipants() {
      return [...participants.values()].sort((a, b) => a.joinedAt - b.joinedAt);
    },
    getChatMessages() {
      return [...chatMessages];
    },
    isEmpty() {
      return participants.size === 0;
    }
  };
};

export type RoomState = ReturnType<typeof createRoomState>;
