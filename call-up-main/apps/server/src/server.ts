import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { createExpressApp } from './bootstrap/express-app.js';
import { createServerConfig } from './config.js';
import { createRoomState } from './domain/room-state.js';
import { createBackendMetrics } from './services/backend-metrics.js';
import { createClientSessionMapping } from './services/client-session-mapping.js';
import { createParticipantSessionTokenService } from './services/participant-session-token.js';
import { createReconnectLifecycle } from './services/reconnect-lifecycle.js';
import { createRoomOrchestrationService } from './services/room-orchestration.js';
import { createSocketSessionMapping } from './services/socket-session-mapping.js';
import { createLocalRoomBroadcaster } from './socket/local-room-broadcaster.js';
import { createLocalSignalingDelivery } from './socket/local-signaling-delivery.js';
import { registerSocketTransportHandlers } from './socket/transport-handlers.js';
import {
  createInMemoryChatMessageStore,
  createInMemoryClientSessionStore,
  createInMemoryParticipantStore,
  createInMemoryParticipantEndpointStore,
  createInMemoryReconnectTimerStore,
  createInMemoryRoomPolicyStore,
  createInMemoryRoomStateStore,
  createInMemorySocketSessionStore
} from './storage/in-memory-adapters.js';

export const createAppServer = () => {
  const config = createServerConfig();
  const startedAt = Date.now();
  const metrics = createBackendMetrics();
  const orchestration = createRoomOrchestrationService({
    roomStore: createInMemoryRoomStateStore(),
    createRoomState: (roomId) =>
      createRoomState(roomId, {
        participantStore: createInMemoryParticipantStore(),
        chatMessageStore: createInMemoryChatMessageStore(config.chatHistoryLimit),
        roomPolicyStore: createInMemoryRoomPolicyStore()
      })
  });
  const app = createExpressApp({
    moduleUrl: import.meta.url,
    getHealthSnapshot: async () => {
      const roomCount = await orchestration.getRoomCount();
      const reconnectTimerCount = await reconnectLifecycle.getScheduledCount();
      const socketSessionCount = await sessionMapping.getActiveSocketSessionCount();
      const endpointCount = await sessionMapping.getActiveParticipantEndpointCount();
      const memoryUsage = process.memoryUsage();
      const metricSnapshot = metrics.snapshot();
      const issues: string[] = [];

      if (reconnectTimerCount >= config.maxReconnectTimers) {
        issues.push('reconnect-timers-saturated');
      }
      if (metricSnapshot.signalingFailures >= config.healthSignalFailuresDegradedAt) {
        issues.push('signaling-failures');
      }
      if (metricSnapshot.deliveryFailures >= config.healthDeliveryFailuresDegradedAt) {
        issues.push('delivery-failures');
      }
      if (metricSnapshot.rateLimitDrops >= config.healthRateLimitDropsDegradedAt) {
        issues.push('rate-limit-drops');
      }
      if (metricSnapshot.backpressureDrops >= config.healthBackpressureDropsDegradedAt) {
        issues.push('backpressure-events');
      }
      if (metricSnapshot.policyViolations >= config.healthPolicyViolationsDegradedAt) {
        issues.push('policy-violations');
      }
      if (memoryUsage.rss >= config.healthMemoryRssDegradedBytes) {
        issues.push('memory-pressure');
      }

      return {
        ok: true,
        rooms: roomCount,
        status: issues.length > 0 ? ('degraded' as const) : ('ok' as const),
        issues,
        uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
        memory: {
          rss: memoryUsage.rss,
          heapUsed: memoryUsage.heapUsed,
          heapTotal: memoryUsage.heapTotal,
          external: memoryUsage.external
        },
        metrics: {
          ...metricSnapshot,
          activeRooms: roomCount,
          activeSocketConnections: io.engine.clientsCount,
          activeSocketSessions: socketSessionCount,
          activeParticipantEndpoints: endpointCount,
          reconnectTimers: reconnectTimerCount
        }
      };
    }
  });
  const httpServer = createServer(app);

  const io = new Server(httpServer, {
    cors: {
      origin: '*'
    }
  });
  const sessionMapping = createSocketSessionMapping({
    serverInstanceId: config.serverInstanceId,
    socketSessionStore: createInMemorySocketSessionStore(),
    participantEndpointStore: createInMemoryParticipantEndpointStore()
  });
  const roomBroadcaster = createLocalRoomBroadcaster({ io });
  const clientSessionMapping = createClientSessionMapping({
    clientSessionStore: createInMemoryClientSessionStore()
  });
  const signalingDelivery = createLocalSignalingDelivery({
    io,
    sessionMapping,
    serverInstanceId: config.serverInstanceId
  });
  const sessionTokenService = createParticipantSessionTokenService({
    secret: config.sessionTokenSecret,
    ttlMs: config.sessionTokenTtlMs
  });

  const reconnectLifecycle = createReconnectLifecycle({
    reconnectGraceMs: config.reconnectGraceMs,
    maxTimers: config.maxReconnectTimers,
    timerStore: createInMemoryReconnectTimerStore(),
    onParticipantGraceExpired: async ({ roomId, participantId, participantName }) => {
      const leaveResult = await orchestration.finalizeReconnectingParticipantLeave(
        roomId,
        participantId,
        participantName
      );
      if (!leaveResult) {
        return;
      }

      await roomBroadcaster.emitToRoom(leaveResult.roomId, 'participant:left', {
        participantId: leaveResult.participantId,
        participants: leaveResult.participants,
        message: leaveResult.message
      });
    }
  });

  registerSocketTransportHandlers({
    io,
    orchestration,
    sessionTokenService,
    clientSessionMapping,
    sessionMapping,
    roomBroadcaster,
    signalingDelivery,
    reconnectLifecycle,
    metrics,
    socketTrafficConfig: {
      maxInFlight: config.maxInflightEventsPerSocket,
      signalMaxBytes: config.signalMaxBytes,
      rateLimits: {
        signal: {
          windowMs: 10_000,
          maxEvents: config.signalRateLimitPer10s
        },
        chat: {
          windowMs: 10_000,
          maxEvents: config.chatRateLimitPer10s
        },
        policy: {
          windowMs: 60_000,
          maxEvents: config.policyRateLimitPerMin
        }
      }
    }
  });

  const sweepTimer = setInterval(() => {
    void orchestration.sweepEmptyRooms();
  }, config.emptyRoomSweepIntervalMs);
  sweepTimer.unref();

  httpServer.on('close', () => {
    clearInterval(sweepTimer);
  });

  return { app, httpServer, io };
};
