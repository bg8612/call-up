import type { ChatMessage } from './room-state.js';

export const createId = (prefix: string) => `${prefix}_${Math.random().toString(36).slice(2, 10)}`;

export const createSystemMessage = (authorName: string, text: string): ChatMessage => ({
  id: createId('msg'),
  authorId: 'system',
  authorName,
  text,
  kind: 'system',
  createdAt: Date.now()
});
