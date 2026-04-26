import { describe, expect, it } from 'vitest';
import { createRoomState } from './room-state.js';

describe('createRoomState', () => {
  it('assigns owner rights to the first participant and tracks chat and media flags', () => {
    const room = createRoomState('alpha-room');

    const owner = room.join({
      socketId: 'socket-owner',
      displayName: 'Alex',
      clientSessionId: 'client-owner'
    }).participant;

    room.addChatMessage({
      id: 'msg-1',
      authorId: owner.id,
      authorName: owner.displayName,
      text: 'hello team',
      kind: 'user',
      createdAt: 1
    });

    room.updateParticipantMedia(owner.id, {
      isCameraOn: true,
      isMicOn: true,
      isScreenSharing: true,
      isSharingAudio: true
    });

    expect(owner.role).toBe('owner');
    expect(room.getParticipants()).toHaveLength(1);
    expect(room.getChatMessages()).toEqual([
      expect.objectContaining({ text: 'hello team' })
    ]);
    expect(room.getParticipant(owner.id)).toEqual(
      expect.objectContaining({
        isCameraOn: true,
        isMicOn: true,
        isScreenSharing: true,
        isSharingAudio: true
      })
    );
  });

  it('promotes the next participant to owner when the current owner leaves', () => {
    const room = createRoomState('alpha-room');

    const first = room.join({
      socketId: 'socket-1',
      displayName: 'Alex',
      clientSessionId: 'client-1'
    }).participant;
    const second = room.join({
      socketId: 'socket-2',
      displayName: 'Mira',
      clientSessionId: 'client-2'
    }).participant;

    room.leave(first.id);

    expect(room.getParticipant(second.id)?.role).toBe('owner');
  });

  it('rejoins an existing participant when the same client session reconnects', () => {
    const room = createRoomState('alpha-room');

    const original = room.join({
      socketId: 'socket-1',
      displayName: 'Alex',
      clientSessionId: 'client-1'
    }).participant;

    room.updateParticipantMedia(original.id, {
      isCameraOn: true,
      isMicOn: true
    });
    room.updateParticipantConnection(original.id, 'reconnecting');

    const rejoined = room.join({
      socketId: 'socket-2',
      displayName: 'Alex',
      clientSessionId: 'client-1'
    });

    expect(rejoined.isRejoin).toBe(true);
    expect(rejoined.participant.id).toBe(original.id);
    expect(rejoined.participant.socketId).toBe('socket-2');
    expect(rejoined.participant.connectionState).toBe('connected');
    expect(rejoined.participant.isCameraOn).toBe(true);
    expect(rejoined.participant.isMicOn).toBe(true);
    expect(room.getParticipants()).toHaveLength(1);
  });
});
