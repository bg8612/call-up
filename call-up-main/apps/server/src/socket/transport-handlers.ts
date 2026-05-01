import type { Server } from 'socket.io';
import type { ParticipantSessionTokenService } from '../services/participant-session-token.js';
import type { ClientSessionMapping } from '../services/client-session-mapping.js';
import type { BackendMetrics } from '../services/backend-metrics.js';
import type { AnonymousAuthRegistry } from '../services/anonymous-auth-registry.js';
import type { ReconnectLifecycle } from '../services/reconnect-lifecycle.js';
import type { RoomOrchestrationService } from '../services/room-orchestration.js';
import type { SocketSessionMapping } from '../services/socket-session-mapping.js';
import { attachChatHandlers } from './chat-handlers.js';
import { attachPolicyHandlers } from './policy-handlers.js';
import { attachRoomLifecycleHandlers } from './room-lifecycle-handlers.js';
import type { RoomBroadcaster } from './room-broadcaster.js';
import type { SignalingDelivery } from './signaling-delivery.js';
import { createSocketTrafficControl, type RateLimitRule } from './socket-traffic-control.js';
import { attachSignalingRelay } from './signaling-relay.js';

type RegisterSocketTransportHandlersOptions = {
  io: Server;
  orchestration: RoomOrchestrationService;
  sessionTokenService: ParticipantSessionTokenService;
  clientSessionMapping: ClientSessionMapping;
  sessionMapping: SocketSessionMapping;
  roomBroadcaster: RoomBroadcaster;
  signalingDelivery: SignalingDelivery;
  reconnectLifecycle: ReconnectLifecycle;
  metrics: BackendMetrics;
  anonymousAuthRegistry: AnonymousAuthRegistry;
  socketTrafficConfig: {
    maxInFlight: number;
    signalMaxBytes: number;
    rateLimits: Partial<Record<'signal' | 'chat' | 'policy', RateLimitRule>>;
  };
};

export const registerSocketTransportHandlers = ({
  io,
  orchestration,
  sessionTokenService,
  clientSessionMapping,
  sessionMapping,
  roomBroadcaster,
  signalingDelivery,
  reconnectLifecycle,
  metrics,
  anonymousAuthRegistry,
  socketTrafficConfig
}: RegisterSocketTransportHandlersOptions) => {
  io.on('connection', (socket) => {
    console.log('[socket] connected', socket.id);
    const trafficControl = createSocketTrafficControl({
      maxInFlight: socketTrafficConfig.maxInFlight,
      rateLimits: socketTrafficConfig.rateLimits,
      metrics
    });

    attachRoomLifecycleHandlers({
      io,
      socket,
      orchestration,
      sessionTokenService,
      clientSessionMapping,
      sessionMapping,
      roomBroadcaster,
      reconnectLifecycle,
      metrics,
      anonymousAuthRegistry
    });

    attachSignalingRelay({
      socket,
      orchestration,
      sessionMapping,
      signalingDelivery,
      metrics,
      trafficControl,
      signalMaxBytes: socketTrafficConfig.signalMaxBytes
    });

    attachChatHandlers({
      socket,
      orchestration,
      sessionMapping,
      roomBroadcaster,
      metrics,
      trafficControl
    });

    attachPolicyHandlers({
      socket,
      orchestration,
      sessionMapping,
      roomBroadcaster,
      metrics,
      trafficControl
    });
  });
};
