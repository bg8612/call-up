import { describe, expect, it } from 'vitest';
import { createInitialCallState, reduceCallState } from './call-state';

describe('reduceCallState', () => {
  it('adds participants and appends chat messages', () => {
    let state = createInitialCallState();

    state = reduceCallState(state, {
      type: 'participants/synced',
      participants: [
        {
          id: 'u1',
          displayName: 'Alex',
          role: 'owner',
          isCameraOn: true,
          isMicOn: true,
          isSpeaking: false,
          isScreenSharing: false,
          isSharingAudio: false,
          isPinned: false,
          connectionState: 'connected'
        }
      ]
    });

    state = reduceCallState(state, {
      type: 'chat/messageReceived',
      message: {
        id: 'm1',
        authorId: 'u1',
        authorName: 'Alex',
        text: 'Ready to start',
        kind: 'user',
        createdAt: 1
      }
    });

    expect(state.participants).toHaveLength(1);
    expect(state.chatMessages[0]?.text).toBe('Ready to start');
  });

  it('pins a participant and clears the pin when requested', () => {
    const seeded = reduceCallState(createInitialCallState(), {
      type: 'participants/synced',
      participants: [
        {
          id: 'u1',
          displayName: 'Alex',
          role: 'owner',
          isCameraOn: true,
          isMicOn: true,
          isSpeaking: false,
          isScreenSharing: false,
          isSharingAudio: false,
          isPinned: false,
          connectionState: 'connected'
        },
        {
          id: 'u2',
          displayName: 'Mira',
          role: 'participant',
          isCameraOn: true,
          isMicOn: true,
          isSpeaking: false,
          isScreenSharing: false,
          isSharingAudio: false,
          isPinned: false,
          connectionState: 'connected'
        }
      ]
    });

    const pinned = reduceCallState(seeded, {
      type: 'participants/pinned',
      participantId: 'u2'
    });

    const unpinned = reduceCallState(pinned, {
      type: 'participants/pinned',
      participantId: null
    });

    expect(pinned.participants.find((item) => item.id === 'u2')?.isPinned).toBe(true);
    expect(unpinned.participants.every((item) => item.isPinned === false)).toBe(true);
  });

  it('preserves speaking state across server syncs and can change it locally', () => {
    const seeded = reduceCallState(createInitialCallState(), {
      type: 'participants/synced',
      participants: [
        {
          id: 'u1',
          displayName: 'Alex',
          role: 'owner',
          isCameraOn: false,
          isMicOn: false,
          isScreenSharing: false,
          isSharingAudio: false,
          isPinned: false,
          connectionState: 'connected'
        }
      ]
    });

    const speaking = reduceCallState(seeded, {
      type: 'participants/speakingChanged',
      participantId: 'u1',
      isSpeaking: true
    });

    const resynced = reduceCallState(speaking, {
      type: 'participants/upserted',
      participant: {
        id: 'u1',
        displayName: 'Alex',
        role: 'owner',
        isCameraOn: false,
        isMicOn: true,
        isScreenSharing: false,
        isSharingAudio: false,
        isPinned: false,
        connectionState: 'connected'
      }
    });

    expect(speaking.participants[0]?.isSpeaking).toBe(true);
    expect(resynced.participants[0]).toEqual(
      expect.objectContaining({
        isMicOn: true,
        isSpeaking: true
      })
    );
  });
});
