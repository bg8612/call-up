import type { Server } from 'socket.io';
import type { SocketSessionMapping } from '../services/socket-session-mapping.js';
import type { SignalingDelivery } from './signaling-delivery.js';

type CreateLocalSignalingDeliveryOptions = {
  io: Server;
  sessionMapping: SocketSessionMapping;
  serverInstanceId: string;
};

// This adapter only knows about sockets connected to the current process.
// Cross-instance signaling still requires a shared endpoint registry + broker/adapter.
export const createLocalSignalingDelivery = ({
  io,
  sessionMapping,
  serverInstanceId
}: CreateLocalSignalingDeliveryOptions): SignalingDelivery => ({
  async deliverSignal(targetParticipantId, payload) {
    const endpoint = await sessionMapping.getParticipantEndpoint(targetParticipantId);
    if (!endpoint) {
      return {
        delivered: false,
        reason: 'TARGET_NOT_CONNECTED'
      };
    }

    if (endpoint.serverInstanceId !== serverInstanceId) {
      return {
        delivered: false,
        reason: 'REMOTE_INSTANCE_UNSUPPORTED'
      };
    }

    io.to(endpoint.transportSocketId).emit('signal:received', payload);
    return {
      delivered: true
    };
  }
});
