import type { Socket } from 'socket.io';
import { chatMessageSchema } from './protocol.js';
import type { BackendMetrics } from '../services/backend-metrics.js';
import type { RoomOrchestrationService } from '../services/room-orchestration.js';
import type { SocketSessionMapping } from '../services/socket-session-mapping.js';
import type { RoomBroadcaster } from './room-broadcaster.js';
import type { SocketTrafficControl } from './socket-traffic-control.js';

type AttachChatHandlersOptions = {
  socket: Socket;
  orchestration: RoomOrchestrationService;
  sessionMapping: SocketSessionMapping;
  roomBroadcaster: RoomBroadcaster;
  trafficControl: SocketTrafficControl;
  metrics: BackendMetrics;
};

export const attachChatHandlers = ({
  socket,
  orchestration,
  sessionMapping,
  roomBroadcaster,
  trafficControl,
  metrics
}: AttachChatHandlersOptions) => {
  socket.on('chat:send', async (payload: unknown) => {
    const gate = trafficControl.enter('chat');
    if (!gate.ok) {
      socket.emit('chat:error', {
        code: gate.code,
        message:
          gate.code === 'RATE_LIMITED'
            ? 'Too many chat messages. Please slow down.'
            : 'Server is busy. Please retry shortly.'
      });
      return;
    }

    try {
      const parsed = chatMessageSchema.safeParse(payload);
      if (!parsed.success) {
        return;
      }

      const session = await sessionMapping.getSocketSession(socket.id);
      if (!session) {
        return;
      }

      const result = await orchestration.sendChatMessage(
        session.roomId,
        session.participantId,
        parsed.data.text
      );
      if (!result) {
        return;
      }

      if (!result.ok) {
        socket.emit('chat:error', {
          message: result.error
        });
        return;
      }

      await roomBroadcaster.emitToRoom(result.roomId, 'chat:received', {
        message: result.message
      });
      metrics.increment('chatEvents');
    } finally {
      gate.release();
    }
  });
};
