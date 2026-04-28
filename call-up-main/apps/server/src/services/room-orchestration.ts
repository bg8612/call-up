import { createId, createSystemMessage } from '../domain/message-factory.js';
import {
  type ChatMessage,
  createRoomState,
  type ParticipantMediaState,
  type ParticipantSnapshot,
  type RoomPolicy,
  type RoomState
} from '../domain/room-state.js';
import type { MediaStateAck, SignalPayload } from '../socket/protocol.js';
import type { KeyValueStore } from '../storage/contracts.js';
import { createInMemoryKeyValueStore } from '../storage/in-memory.js';

export type RoomStateStore = KeyValueStore<string, RoomState>;

type JoinParticipantInput = {
  socketId: string;
  roomId: string;
  displayName: string;
  reconnectIdentity?: {
    roomId: string;
    participantId: string;
  };
};

type CreateRoomOrchestrationServiceOptions = {
  roomStore?: RoomStateStore;
  createRoomState?: (roomId: string) => RoomState;
};

export const createRoomOrchestrationService = (
  options: CreateRoomOrchestrationServiceOptions = {}
) => {
  const rooms = options.roomStore ?? createInMemoryKeyValueStore<string, RoomState>();
  const createRoom = options.createRoomState ?? createRoomState;

  const getOrCreateRoom = async (roomId: string) => {
    const existing = await rooms.get(roomId);
    if (existing) {
      return existing;
    }

    const room = createRoom(roomId);
    await rooms.set(roomId, room);
    return room;
  };

  const removeRoomIfEmpty = async (roomId: string) => {
    const room = await rooms.get(roomId);
    if (room && (await room.isEmpty())) {
      await rooms.delete(roomId);
      return true;
    }

    return false;
  };

  const finalizeParticipantLeave = async (
    roomId: string,
    participantId: string,
    participantName: string
  ) => {
    const room = await rooms.get(roomId);
    if (!room) {
      await removeRoomIfEmpty(roomId);
      return undefined;
    }

    const didLeave = await room.leave(participantId);
    if (!didLeave) {
      await removeRoomIfEmpty(roomId);
      return undefined;
    }

    const systemMessage = await room.addChatMessage(
      createSystemMessage('System', `${participantName} left the room`)
    );
    const participants = await room.getParticipants();
    await removeRoomIfEmpty(roomId);

    return {
      roomId,
      participantId,
      participants,
      message: systemMessage
    };
  };

  const updatePolicyAndEnforce = async (
    roomId: string,
    participantId: string,
    patch: Partial<RoomPolicy>
  ) => {
    const room = await rooms.get(roomId);
    const participant = await room?.getParticipant(participantId);
    if (!room || !participant || participant.role !== 'owner') {
      return {
        ok: false as const,
        error: 'NOT_ALLOWED' as const
      };
    }

    const previousPolicy = await room.getPolicy();
    const policy = await room.updatePolicy(patch);
    const participants = await room.getParticipants();
    const forcedParticipants: ParticipantSnapshot[] = [];

    for (const roomParticipant of participants) {
      if (roomParticipant.role === 'owner') {
        continue;
      }

      const mediaPatch: Partial<ParticipantMediaState> = {};
      if (policy.allowScreenShare === false && roomParticipant.isScreenSharing) {
        mediaPatch.isScreenSharing = false;
        mediaPatch.screenStreamId = undefined;
      }

      if (policy.allowSystemAudio === false && roomParticipant.isSharingAudio) {
        mediaPatch.isSharingAudio = false;
      }

      if (Object.keys(mediaPatch).length === 0) {
        continue;
      }

      const updated = await room.updateParticipantMedia(roomParticipant.id, mediaPatch);
      if (updated) {
        forcedParticipants.push(updated);
      }
    }

    let enforcementMessage: ChatMessage | undefined;
    if (previousPolicy.allowChat && policy.allowChat === false) {
      enforcementMessage = await room.addChatMessage(
        createSystemMessage('System', 'Chat was disabled by the room owner')
      );
    }

    return {
      ok: true as const,
      roomId,
      policy,
      forcedParticipants,
      enforcementMessage
    };
  };

  const updateSpeakingStateInRoom = async (roomId: string, participantId: string, isSpeaking: boolean) => {
    const room = await rooms.get(roomId);
    const participant = await room?.getParticipant(participantId);
    if (!room || !participant) {
      return {
        ack: { ok: false, error: 'Participant not found' } satisfies MediaStateAck
      };
    }

    const updated = await room.updateParticipantMedia(participantId, { isSpeaking });
    if (!updated) {
      return {
        ack: { ok: false, error: 'Failed to update participant media' } satisfies MediaStateAck
      };
    }

    return {
      roomId,
      participant: updated,
      ack: {
        ok: true,
        participant: updated
      } satisfies MediaStateAck
    };
  };

  return {
    async getRoomCount() {
      return rooms.size();
    },
    async sweepEmptyRooms() {
      const allRooms = await rooms.values();
      let removed = 0;

      for (const room of allRooms) {
        const didRemove = await removeRoomIfEmpty(room.roomId);
        if (didRemove) {
          removed += 1;
        }
      }

      return removed;
    },
    async joinParticipant(input: JoinParticipantInput) {
      const room = await getOrCreateRoom(input.roomId);
      let participant;
      let isRejoin = false;

      const reconnectIdentity = input.reconnectIdentity;
      const canReconnect = reconnectIdentity && reconnectIdentity.roomId === input.roomId;

      if (canReconnect) {
        participant = await room.reconnect(reconnectIdentity.participantId, {
          socketId: input.socketId,
          displayName: input.displayName
        });
        isRejoin = Boolean(participant);
      }

      if (!participant) {
        const joinResult = await room.join({
          socketId: input.socketId,
          displayName: input.displayName
        });
        participant = joinResult.participant;
        isRejoin = false;
      }

      const systemMessage = isRejoin
        ? undefined
        : await room.addChatMessage(
            createSystemMessage('System', `${participant.displayName} joined the room`)
          );

      return {
        roomId: input.roomId,
        participant,
        isRejoin,
        participants: await room.getParticipants(),
        chatMessages: await room.getChatMessages(),
        policy: await room.getPolicy(),
        joinMessage: systemMessage
      };
    },
    async leaveParticipant(roomId: string, participantId: string) {
      const room = await rooms.get(roomId);
      const participant = await room?.getParticipant(participantId);
      if (!room || !participant) {
        await removeRoomIfEmpty(roomId);
        return undefined;
      }

      return finalizeParticipantLeave(roomId, participantId, participant.displayName);
    },
    async markParticipantReconnecting(roomId: string, participantId: string) {
      const room = await rooms.get(roomId);
      const participant = await room?.getParticipant(participantId);
      if (!room || !participant) {
        await removeRoomIfEmpty(roomId);
        return undefined;
      }

      const updated = await room.updateParticipantConnection(participantId, 'reconnecting');
      if (!updated) {
        await removeRoomIfEmpty(roomId);
        return undefined;
      }

      return {
        roomId,
        participantId,
        participantName: participant.displayName,
        participant: updated
      };
    },
    async finalizeReconnectingParticipantLeave(
      roomId: string,
      participantId: string,
      participantName: string
    ) {
      const room = await rooms.get(roomId);
      const participant = await room?.getParticipant(participantId);
      if (!room || !participant || participant.connectionState !== 'reconnecting') {
        return undefined;
      }

      return finalizeParticipantLeave(roomId, participantId, participant.displayName || participantName);
    },
    async relaySignalInRoom(
      roomId: string,
      sourceParticipantId: string,
      payload: SignalPayload
    ) {
      const room = await rooms.get(roomId);
      const sourceParticipant = await room?.getParticipant(sourceParticipantId);
      const targetParticipant = await room?.getParticipant(payload.targetParticipantId);
      if (!room || !sourceParticipant || !targetParticipant) {
        return undefined;
      }

      return {
        targetParticipantId: targetParticipant.id,
        fromParticipantId: sourceParticipant.id,
        signal: payload.signal
      };
    },
    async sendChatMessage(roomId: string, authorParticipantId: string, text: string) {
      const room = await rooms.get(roomId);
      const author = await room?.getParticipant(authorParticipantId);
      if (!room || !author) {
        return undefined;
      }

      const policy = await room.getPolicy();
      if (!policy.allowChat) {
        return {
          ok: false as const,
          error: 'Chat is disabled by the room owner'
        };
      }

      const message = await room.addChatMessage({
        id: createId('msg'),
        authorId: author.id,
        authorName: author.displayName,
        text,
        kind: 'user',
        createdAt: Date.now()
      });

      return {
        ok: true as const,
        roomId,
        message
      };
    },
    async updateMediaState(
      roomId: string,
      participantId: string,
      patch: Partial<ParticipantMediaState>
    ) {
      const room = await rooms.get(roomId);
      const participant = await room?.getParticipant(participantId);
      if (!room || !participant) {
        return {
          ack: { ok: false, error: 'Participant not found' } satisfies MediaStateAck
        };
      }

      const policy = await room.getPolicy();
      const nextPatch = { ...patch };

      if (participant.role !== 'owner' && policy.allowScreenShare === false) {
        nextPatch.isScreenSharing = false;
        nextPatch.screenStreamId = undefined;
      }

      if (participant.role !== 'owner' && policy.allowSystemAudio === false) {
        nextPatch.isSharingAudio = false;
      }

      const updated = await room.updateParticipantMedia(participantId, nextPatch);
      if (!updated) {
        return {
          ack: { ok: false, error: 'Failed to update participant media' } satisfies MediaStateAck
        };
      }

      return {
        roomId,
        participant: updated,
        ack: {
          ok: true,
          participant: updated
        } satisfies MediaStateAck
      };
    },
    async updateSpeakingState(roomId: string, participantId: string, isSpeaking: boolean) {
      return updateSpeakingStateInRoom(roomId, participantId, isSpeaking);
    },
    async updatePolicy(roomId: string, participantId: string, patch: Partial<RoomPolicy>) {
      return updatePolicyAndEnforce(roomId, participantId, patch);
    },
    async updatePolicyAndEnforce(roomId: string, participantId: string, patch: Partial<RoomPolicy>) {
      return updatePolicyAndEnforce(roomId, participantId, patch);
    }
  };
};

export type RoomOrchestrationService = ReturnType<typeof createRoomOrchestrationService>;
