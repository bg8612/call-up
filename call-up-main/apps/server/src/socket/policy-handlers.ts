import type { Socket } from 'socket.io';
import type { BackendMetrics } from '../services/backend-metrics.js';
import type { RoomOrchestrationService } from '../services/room-orchestration.js';
import type { SocketSessionMapping } from '../services/socket-session-mapping.js';
import { mediaStateSchema, policySchema, speakingStateSchema, type MediaStateAck } from './protocol.js';
import type { RoomBroadcaster } from './room-broadcaster.js';
import type { SocketTrafficControl } from './socket-traffic-control.js';

type AttachPolicyHandlersOptions = {
  socket: Socket;
  orchestration: RoomOrchestrationService;
  sessionMapping: SocketSessionMapping;
  roomBroadcaster: RoomBroadcaster;
  trafficControl: SocketTrafficControl;
  metrics: BackendMetrics;
};

export const attachPolicyHandlers = ({
  socket,
  orchestration,
  sessionMapping,
  roomBroadcaster,
  trafficControl,
  metrics
}: AttachPolicyHandlersOptions) => {
  socket.on(
    'participant:media-state',
    async (payload: unknown, ack?: (response: MediaStateAck) => void) => {
      const parsed = mediaStateSchema.safeParse(payload);
      if (!parsed.success) {
        ack?.({ ok: false, error: 'Invalid media state payload' });
        return;
      }

      const session = await sessionMapping.getSocketSession(socket.id);
      if (!session) {
        ack?.({ ok: false, error: 'Socket is not joined to a room' });
        return;
      }

      const result = await orchestration.updateMediaState(
        session.roomId,
        session.participantId,
        parsed.data
      );
      ack?.(result.ack);

      if (result.ack.ok && result.roomId && result.participant) {
        await roomBroadcaster.emitToRoomExcept(result.roomId, socket.id, 'participant:updated', {
          participant: result.participant
        });
      }
    }
  );

  socket.on('participant:speaking-state', async (payload: unknown) => {
    const parsed = speakingStateSchema.safeParse(payload);
    if (!parsed.success) {
      return;
    }

    const session = await sessionMapping.getSocketSession(socket.id);
    if (!session) {
      return;
    }

    const result = await orchestration.updateSpeakingState(
      session.roomId,
      session.participantId,
      parsed.data.isSpeaking
    );

    if (result.ack.ok && result.roomId && result.participant) {
      await roomBroadcaster.emitToRoomExcept(result.roomId, socket.id, 'participant:updated', {
        participant: result.participant
      });
    }
  });

  socket.on('room:policy', async (payload: unknown) => {
    const gate = trafficControl.enter('policy');
    if (!gate.ok) {
      socket.emit('room:policy-error', {
        code: gate.code,
        message:
          gate.code === 'RATE_LIMITED'
            ? 'Too many policy updates. Please slow down.'
            : 'Server is busy. Please retry shortly.'
      });
      return;
    }

    try {
      const parsed = policySchema.safeParse(payload);
      if (!parsed.success) {
        metrics.increment('policyViolations');
        return;
      }

      const session = await sessionMapping.getSocketSession(socket.id);
      if (!session) {
        return;
      }

      const result = await orchestration.updatePolicyAndEnforce(
        session.roomId,
        session.participantId,
        parsed.data
      );
      if (!result.ok) {
        metrics.increment('policyViolations');
        socket.emit('room:policy-error', {
          code: 'NOT_ALLOWED',
          message: 'Only room owner can change room policy'
        });
        return;
      }

      await roomBroadcaster.emitToRoom(result.roomId, 'room:policy-updated', {
        policy: result.policy
      });
      for (const forcedParticipant of result.forcedParticipants) {
        await roomBroadcaster.emitToRoom(result.roomId, 'participant:updated', {
          participant: forcedParticipant
        });
      }

      await roomBroadcaster.emitToRoom(result.roomId, 'room:policy-enforced', {
        policy: result.policy,
        forcedParticipants: result.forcedParticipants,
        message: result.enforcementMessage
      });
      if (result.forcedParticipants.length > 0 || result.enforcementMessage) {
        metrics.increment('policyEnforcements');
      }
    } finally {
      gate.release();
    }
  });
};
