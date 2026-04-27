import type { Server, Socket } from 'socket.io';
import type { ReconnectLifecycle } from '../services/reconnect-lifecycle.js';
import type { BackendMetrics } from '../services/backend-metrics.js';
import type { ParticipantSessionTokenService } from '../services/participant-session-token.js';
import type { RoomOrchestrationService } from '../services/room-orchestration.js';
import type { SocketSessionMapping } from '../services/socket-session-mapping.js';
import { joinRoomSchema, type JoinAck } from './protocol.js';
import type { RoomBroadcaster } from './room-broadcaster.js';

type AttachRoomLifecycleHandlersOptions = {
  socket: Socket;
  io: Server;
  orchestration: RoomOrchestrationService;
  sessionTokenService: ParticipantSessionTokenService;
  sessionMapping: SocketSessionMapping;
  roomBroadcaster: RoomBroadcaster;
  reconnectLifecycle: ReconnectLifecycle;
  metrics: BackendMetrics;
};

export const attachRoomLifecycleHandlers = ({
  socket,
  io,
  orchestration,
  sessionTokenService,
  sessionMapping,
  roomBroadcaster,
  reconnectLifecycle,
  metrics
}: AttachRoomLifecycleHandlersOptions) => {
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
    const parsed = joinRoomSchema.safeParse(payload);
    if (!parsed.success) {
      ack?.({ ok: false, error: 'Invalid join payload' });
      return;
    }

    const { roomId, displayName } = parsed.data;
    const presentedToken = parsed.data.sessionToken?.trim() || parsed.data.clientSessionId?.trim();
    const reconnectIdentity = sessionTokenService.verify(presentedToken);
    const joinResult = await orchestration.joinParticipant({
      socketId: socket.id,
      roomId,
      displayName,
      reconnectIdentity
    });
    const participant = joinResult.participant;
    const sessionToken = sessionTokenService.issue({
      roomId,
      participantId: participant.id
    });

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
      clientSessionId: sessionToken,
      sessionToken,
      roomId,
      participants: joinResult.participants,
      chatMessages: joinResult.chatMessages,
      policy: joinResult.policy
    });
  });

  socket.on('room:leave', async (ack?: () => void) => {
    const session = await sessionMapping.unbindSocketSession(socket.id);
    if (!session) {
      ack?.();
      return;
    }

    socket.leave(session.roomId);
    const leaveResult = await orchestration.leaveParticipant(session.roomId, session.participantId);
    if (!leaveResult) {
      ack?.();
      return;
    }

    await reconnectLifecycle.cancelParticipantRemoval(leaveResult.participantId);

    await roomBroadcaster.emitToRoomExcept(leaveResult.roomId, socket.id, 'participant:left', {
      participantId: leaveResult.participantId,
      participants: leaveResult.participants,
      message: leaveResult.message
    });
    ack?.();
  });

  socket.on('disconnect', async (reason) => {
    console.log('[socket] disconnected', socket.id, reason);
    const session = await sessionMapping.unbindSocketSession(socket.id);
    if (!session) {
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

    await roomBroadcaster.emitToRoom(leaveResult.roomId, 'participant:left', {
      participantId: leaveResult.participantId,
      participants: leaveResult.participants,
      message: leaveResult.message
    });
  });
};
