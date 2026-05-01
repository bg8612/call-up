import type { Socket } from 'socket.io';
import { signalSchema } from './protocol.js';
import type { BackendMetrics } from '../services/backend-metrics.js';
import type { RoomOrchestrationService } from '../services/room-orchestration.js';
import type { SocketSessionMapping } from '../services/socket-session-mapping.js';
import type { SignalingDelivery } from './signaling-delivery.js';
import type { SocketTrafficControl } from './socket-traffic-control.js';

type AttachSignalingRelayOptions = {
  socket: Socket;
  orchestration: RoomOrchestrationService;
  sessionMapping: SocketSessionMapping;
  signalingDelivery: SignalingDelivery;
  trafficControl: SocketTrafficControl;
  metrics: BackendMetrics;
  signalMaxBytes: number;
};

export const attachSignalingRelay = ({
  socket,
  orchestration,
  sessionMapping,
  signalingDelivery,
  trafficControl,
  metrics,
  signalMaxBytes
}: AttachSignalingRelayOptions) => {
  const signalError = (code: string, message: string) => {
    socket.emit('signal:error', { code, message });
  };

  socket.on('signal:send', async (payload: unknown) => {
    const gate = trafficControl.enter('signal');
    if (!gate.ok) {
      signalError(
        gate.code,
        gate.code === 'RATE_LIMITED'
          ? 'Too many signaling events. Please slow down.'
          : 'Server is busy. Please retry shortly.'
      );
      return;
    }

    try {
      const parsed = signalSchema.safeParse(payload);
      if (!parsed.success) {
        metrics.increment('signalingFailures');
        signalError('INVALID_SIGNAL_PAYLOAD', 'Invalid signaling payload');
        return;
      }

      const signalBytes = Buffer.byteLength(JSON.stringify(parsed.data.signal), 'utf8');
      if (signalBytes > signalMaxBytes) {
        metrics.increment('signalingFailures');
        signalError('INVALID_SIGNAL_PAYLOAD', 'Signaling payload exceeds size limit');
        return;
      }

      const session = await sessionMapping.getSocketSession(socket.id);
      if (!session) {
        console.warn('[signal] dropped event without active socket session', { socketId: socket.id });
        return;
      }

      const relay = await orchestration.relaySignalInRoom(
        session.roomId,
        session.participantId,
        parsed.data
      );
      if (!relay) {
        metrics.increment('signalingFailures');
        return;
      }

      const deliveryResult = await signalingDelivery.deliverSignal(relay.targetParticipantId, {
        fromParticipantId: relay.fromParticipantId,
        signal: relay.signal
      });
      if (!deliveryResult.delivered) {
        metrics.increment('deliveryFailures');
        console.warn('[signal] delivery failed', {
          roomId: session.roomId,
          fromParticipantId: relay.fromParticipantId,
          toParticipantId: relay.targetParticipantId,
          reason: deliveryResult.reason
        });
      } else {
        console.log('[signal] delivered', {
          roomId: session.roomId,
          fromParticipantId: relay.fromParticipantId,
          toParticipantId: relay.targetParticipantId,
          signalType: relay.signal.type
        });
      }
    } finally {
      gate.release();
    }
  });
};
