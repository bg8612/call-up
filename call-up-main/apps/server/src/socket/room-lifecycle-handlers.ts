import type { Server, Socket } from 'socket.io';
import type { ReconnectLifecycle } from '../services/reconnect-lifecycle.js';
import type { BackendMetrics } from '../services/backend-metrics.js';
import type { AnonymousAuthRegistry } from '../services/anonymous-auth-registry.js';
import type { ParticipantSessionTokenService } from '../services/participant-session-token.js';
import type { ClientSessionMapping } from '../services/client-session-mapping.js';
import type { RoomOrchestrationService } from '../services/room-orchestration.js';
import type { SocketSessionMapping } from '../services/socket-session-mapping.js';
import { joinRoomSchema, type JoinAck } from './protocol.js';
import type { RoomBroadcaster } from './room-broadcaster.js';

type AttachRoomLifecycleHandlersOptions = {
  socket: Socket;
  io: Server;
  orchestration: RoomOrchestrationService;
  sessionTokenService: ParticipantSessionTokenService;
  clientSessionMapping: ClientSessionMapping;
  sessionMapping: SocketSessionMapping;
  roomBroadcaster: RoomBroadcaster;
  reconnectLifecycle: ReconnectLifecycle;
  metrics: BackendMetrics;
  anonymousAuthRegistry: AnonymousAuthRegistry;
};

export const attachRoomLifecycleHandlers = ({
  socket,
  io,
  orchestration,
  sessionTokenService,
  clientSessionMapping,
  sessionMapping,
  roomBroadcaster,
  reconnectLifecycle,
  metrics,
  anonymousAuthRegistry
}: AttachRoomLifecycleHandlersOptions) => {
  let isExplicitLeaveInProgress = false;
  let joinAttemptCounter = 0;

  const evictSocketFromRoom = (socketId: string | undefined, roomId: string | undefined, reason: string) => {
    if (!socketId || !roomId || socketId === socket.id) {
      return;
    }

    const staleSocket = io.sockets.sockets.get(socketId);
    if (!staleSocket) {
      return;
    }

    staleSocket.leave(roomId);
    staleSocket.emit('session:evicted', {
      roomId,
      reason
    });
  };

  socket.on('room:join', async (payload: unknown, ack?: (response: JoinAck) => void) => {
    const joinAttemptId = `${socket.id}:${++joinAttemptCounter}`;
    const parsed = joinRoomSchema.safeParse(payload);
    if (!parsed.success) {
      console.warn('[room] join rejected invalid payload', { joinAttemptId, socketId: socket.id });
      ack?.({ ok: false, error: 'Invalid join payload' });
      return;
    }

    const { roomId, displayName } = parsed.data;
    const anonymousAuthToken = parsed.data.anonymousAuthToken?.trim();
    if (!anonymousAuthToken) {
      ack?.({ ok: false, error: 'Anonymous authorization token is required' });
      return;
    }
    const sessionToken = parsed.data.sessionToken?.trim();
    const clientSessionId = parsed.data.clientSessionId?.trim();
    const reconnectIdentityFromToken = sessionTokenService.verify(sessionToken);
    const mappedParticipantId =
      !reconnectIdentityFromToken && clientSessionId
        ? await clientSessionMapping.getParticipantId(roomId, clientSessionId)
        : undefined;
    const reconnectIdentity =
      reconnectIdentityFromToken ??
      (mappedParticipantId
        ? {
            roomId,
            participantId: mappedParticipantId
          }
        : undefined);
    const tokenBinding = await anonymousAuthRegistry.getBinding(anonymousAuthToken);
    const reconnectParticipantToken = reconnectIdentity?.participantId
      ? await anonymousAuthRegistry.getTokenForParticipant(reconnectIdentity.participantId)
      : undefined;
    if (
      reconnectParticipantToken &&
      reconnectParticipantToken !== anonymousAuthToken &&
      reconnectIdentity?.roomId === roomId
    ) {
      ack?.({
        ok: false,
        error: 'Anonymous authorization token does not match the existing browser identity for this participant.'
      });
      return;
    }
    const isReconnectWithSameParticipant =
      Boolean(reconnectIdentity?.participantId) &&
      tokenBinding?.participantId === reconnectIdentity?.participantId &&
      tokenBinding?.roomId === roomId;
    if (tokenBinding && !isReconnectWithSameParticipant) {
      const sameRoom = tokenBinding.roomId === roomId;
      if (sameRoom) {
        ack?.({
          ok: false,
          error: 'This browser has already joined this room. Re-entry is blocked for the same anonymous token.'
        });
        return;
      }

      console.log('[room] anonymous token transfer', {
        joinAttemptId,
        socketId: socket.id,
        fromRoomId: tokenBinding.roomId,
        toRoomId: roomId,
        participantId: tokenBinding.participantId
      });
      await reconnectLifecycle.cancelParticipantRemoval(tokenBinding.participantId);

      const previousEndpoint = await sessionMapping.getParticipantEndpoint(tokenBinding.participantId);
      if (previousEndpoint) {
        await sessionMapping.unbindSocketSession(previousEndpoint.transportSocketId);
        evictSocketFromRoom(previousEndpoint.transportSocketId, tokenBinding.roomId, 'ANON_TOKEN_TRANSFER');
      }

      const previousLeaveResult = await orchestration.leaveParticipant(
        tokenBinding.roomId,
        tokenBinding.participantId
      );
      await anonymousAuthRegistry.unbindParticipant(tokenBinding.participantId);

      if (previousLeaveResult) {
        await roomBroadcaster.emitToRoom(previousLeaveResult.roomId, 'participant:left', {
          participantId: previousLeaveResult.participantId,
          participants: previousLeaveResult.participants,
          message: previousLeaveResult.message
        });
      }
    }

    const joinResult = await orchestration.joinParticipant({
      socketId: socket.id,
      roomId,
      displayName,
      reconnectIdentity
    });
    console.log('[room] join attempt accepted', {
      joinAttemptId,
      roomId,
      socketId: socket.id,
      participantId: joinResult.participant.id,
      rejoin: joinResult.isRejoin
    });
    const participant = joinResult.participant;
    await anonymousAuthRegistry.bindTokenToParticipant(anonymousAuthToken, {
      roomId,
      participantId: participant.id
    });
    const nextSessionToken = sessionTokenService.issue({
      roomId,
      participantId: participant.id
    });
    if (clientSessionId) {
      await clientSessionMapping.bindClientSession(roomId, clientSessionId, participant.id);
    }

    const bindResult = await sessionMapping.bindSocketSession(socket.id, {
      roomId,
      participantId: participant.id
    });
    if (
      bindResult.previousSocketSession &&
      bindResult.previousSocketSession.roomId !== roomId
    ) {
      socket.leave(bindResult.previousSocketSession.roomId);
    }

    socket.join(roomId);
    evictSocketFromRoom(
      bindResult.replacedSocketId,
      bindResult.replacedSocketSession?.roomId ?? roomId,
      'SESSION_REBOUND'
    );
    await reconnectLifecycle.cancelParticipantRemoval(participant.id);

    if (!joinResult.isRejoin) {
      await roomBroadcaster.emitToRoomExcept(roomId, socket.id, 'participant:joined', {
        participant,
        message: joinResult.joinMessage
      });
    } else {
      await roomBroadcaster.emitToRoomExcept(roomId, socket.id, 'participant:updated', {
        participant
      });
    }

    console.log('[room] joined', {
      roomId,
      participantId: participant.id,
      displayName: participant.displayName,
      socketId: socket.id,
      participantsInRoom: joinResult.participants.map((item) => ({
        id: item.id,
        displayName: item.displayName,
        role: item.role
      }))
    });

    ack?.({
      ok: true,
      participantId: participant.id,
      clientSessionId: nextSessionToken,
      sessionToken: nextSessionToken,
      roomId,
      participants: joinResult.participants,
      chatMessages: joinResult.chatMessages,
      policy: joinResult.policy
    });
  });

  socket.on('room:leave', async (ack?: () => void) => {
    isExplicitLeaveInProgress = true;
    try {
      const session = await sessionMapping.unbindSocketSession(socket.id);
      if (!session) {
        return;
      }

      socket.leave(session.roomId);
      const leaveResult = await orchestration.leaveParticipant(session.roomId, session.participantId);
      if (!leaveResult) {
        return;
      }

      await reconnectLifecycle.cancelParticipantRemoval(leaveResult.participantId);
      await anonymousAuthRegistry.unbindParticipant(leaveResult.participantId);

      await roomBroadcaster.emitToRoomExcept(leaveResult.roomId, socket.id, 'participant:left', {
        participantId: leaveResult.participantId,
        participants: leaveResult.participants,
        message: leaveResult.message
      });
    } finally {
      isExplicitLeaveInProgress = false;
      ack?.();
    }
  });

  socket.on('disconnect', async (reason) => {
    console.log('[socket] disconnected', socket.id, reason);

    const isExplicitClientDisconnect = reason === 'client namespace disconnect';

    const session = await sessionMapping.unbindSocketSession(socket.id);
    if (!session) {
      return;
    }

    if (isExplicitLeaveInProgress || isExplicitClientDisconnect) {
      await reconnectLifecycle.cancelParticipantRemoval(session.participantId);
      const leaveResult = await orchestration.leaveParticipant(session.roomId, session.participantId);
      if (!leaveResult) {
        return;
      }
      await anonymousAuthRegistry.unbindParticipant(leaveResult.participantId);

      await roomBroadcaster.emitToRoomExcept(leaveResult.roomId, socket.id, 'participant:left', {
        participantId: leaveResult.participantId,
        participants: leaveResult.participants,
        message: leaveResult.message
      });
      return;
    }

    const disconnectResult = await orchestration.markParticipantReconnecting(
      session.roomId,
      session.participantId
    );
    if (!disconnectResult) {
      return;
    }

    metrics.increment('reconnectAttempts');

    await roomBroadcaster.emitToRoomExcept(disconnectResult.roomId, socket.id, 'participant:updated', {
      participant: disconnectResult.participant
    });
    const scheduleResult = await reconnectLifecycle.scheduleParticipantRemoval(
      disconnectResult.roomId,
      disconnectResult.participantId,
      disconnectResult.participantName
    );
    if (scheduleResult.ok) {
      return;
    }

    const leaveResult = await orchestration.finalizeReconnectingParticipantLeave(
      disconnectResult.roomId,
      disconnectResult.participantId,
      disconnectResult.participantName
    );
    if (!leaveResult) {
      return;
    }
    await anonymousAuthRegistry.unbindParticipant(leaveResult.participantId);

    await roomBroadcaster.emitToRoom(leaveResult.roomId, 'participant:left', {
      participantId: leaveResult.participantId,
      participants: leaveResult.participants,
      message: leaveResult.message
    });
  });
};
