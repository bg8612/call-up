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
  clientSessionId: string;
};

type InternalParticipant = ParticipantSnapshot & {
  clientSessionId: string;
};

export type JoinResult = {
  participant: ParticipantSnapshot;
  isRejoin: boolean;
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
  const participants = new Map<string, InternalParticipant>();
  const chatMessages: ChatMessage[] = [];
  let policy: RoomPolicy = { ...defaultPolicy };

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
    isScreenSharing: participant.isScreenSharing,
    isSharingAudio: participant.isSharingAudio,
    cameraStreamId: participant.cameraStreamId,
    screenStreamId: participant.screenStreamId
  });

  const getParticipantByClientSessionId = (clientSessionId: string) =>
    [...participants.values()].find((participant) => participant.clientSessionId === clientSessionId);

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
      const existing = getParticipantByClientSessionId(payload.clientSessionId);
      if (existing) {
        const updated: InternalParticipant = {
          ...existing,
          socketId: payload.socketId,
          displayName: payload.displayName.trim() || existing.displayName,
          connectionState: 'connected'
        };

        participants.set(updated.id, updated);
        return {
          participant: toPublicParticipant(updated),
          isRejoin: true
        };
      }

      const participant: InternalParticipant = {
        id: createParticipantId(),
        socketId: payload.socketId,
        displayName: payload.displayName.trim() || 'Guest',
        clientSessionId: payload.clientSessionId,
        role: participants.size === 0 ? 'owner' : 'participant',
        joinedAt: Date.now(),
        isPinned: false,
        connectionState: 'connected',
        ...defaultMediaState
      };

      participants.set(participant.id, participant);
      return {
        participant: toPublicParticipant(participant),
        isRejoin: false
      };
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
      return toPublicParticipant(updated);
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
      return toPublicParticipant(updated);
    },
    updateParticipantSocket(participantId: string, socketId: string) {
      const participant = participants.get(participantId);
      if (!participant) {
        return undefined;
      }

      const updated = {
        ...participant,
        socketId
      };

      participants.set(participantId, updated);
      return toPublicParticipant(updated);
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
      const participant = participants.get(participantId);
      return participant ? toPublicParticipant(participant) : undefined;
    },
    getParticipantBySocketId(socketId: string) {
      const participant = [...participants.values()].find((item) => item.socketId === socketId);
      return participant ? toPublicParticipant(participant) : undefined;
    },
    getParticipants() {
      return [...participants.values()]
        .sort((a, b) => a.joinedAt - b.joinedAt)
        .map(toPublicParticipant);
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
