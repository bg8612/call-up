import type {
  ChatMessage,
  InternalParticipant,
  RoomPolicyStore,
  RoomState
} from '../domain/room-state.js';
import type { ReconnectTimerStore } from '../services/reconnect-lifecycle.js';
import type { ClientSessionStore } from '../services/client-session-mapping.js';
import type { RoomStateStore } from '../services/room-orchestration.js';
import type {
  ParticipantEndpoint,
  ParticipantEndpointStore,
  SocketSession,
  SocketSessionStore
} from '../services/socket-session-mapping.js';
import {
  createInMemoryKeyValueStore,
  createInMemoryListStore,
  createInMemorySingletonStore
} from './in-memory.js';
import type { ChatMessageStore, ParticipantStore } from '../domain/room-state.js';

export const createInMemoryRoomStateStore = (): RoomStateStore =>
  createInMemoryKeyValueStore<string, RoomState>();

export const createInMemorySocketSessionStore = (): SocketSessionStore =>
  createInMemoryKeyValueStore<string, SocketSession>();

export const createInMemoryParticipantEndpointStore = (): ParticipantEndpointStore =>
  createInMemoryKeyValueStore<string, ParticipantEndpoint>();

export const createInMemoryReconnectTimerStore = (): ReconnectTimerStore =>
  createInMemoryKeyValueStore<string, ReturnType<typeof setTimeout>>();

export const createInMemoryClientSessionStore = (): ClientSessionStore =>
  createInMemoryKeyValueStore<string, string>();

export const createInMemoryParticipantStore = (): ParticipantStore =>
  createInMemoryKeyValueStore<string, InternalParticipant>();

export const createInMemoryChatMessageStore = (maxItems?: number): ChatMessageStore =>
  createInMemoryListStore<ChatMessage>({ maxItems });

export const createInMemoryRoomPolicyStore = (): RoomPolicyStore =>
  createInMemorySingletonStore();
