import { describe, expect, it } from 'vitest';
import { createRoomState } from './room-state.js';

describe('createRoomState', () => {
  it('assigns owner rights to the first participant and tracks chat and media flags', async () => {
    const room = createRoomState('alpha-room');

    const owner = (
      await room.join({
        socketId: 'socket-owner',
        displayName: 'Alex'
      })
    ).participant;

    await room.addChatMessage({
      id: 'msg-1',
      authorId: owner.id,
      authorName: owner.displayName,
      text: 'hello team',
      kind: 'user',
      createdAt: 1
    });

    await room.updateParticipantMedia(owner.id, {
      isCameraOn: true,
      isMicOn: true,
      isScreenSharing: true,
      isSharingAudio: true
    });

    expect(owner.role).toBe('owner');
    await expect(room.getParticipants()).resolves.toHaveLength(1);
    await expect(room.getChatMessages()).resolves.toEqual([
      expect.objectContaining({ text: 'hello team' })
    ]);
    await expect(room.getParticipant(owner.id)).resolves.toEqual(
      expect.objectContaining({
        isCameraOn: true,
        isMicOn: true,
        isScreenSharing: true,
        isSharingAudio: true
      })
    );
  });

  it('promotes the next participant to owner when the current owner leaves', async () => {
    const room = createRoomState('alpha-room');

    const first = (
      await room.join({
      socketId: 'socket-1',
        displayName: 'Alex'
      })
    ).participant;
    const second = (
      await room.join({
      socketId: 'socket-2',
        displayName: 'Mira'
      })
    ).participant;

    await room.leave(first.id);

    await expect(room.getParticipant(second.id)).resolves.toMatchObject({
      role: 'owner'
    });
  });

  it('reconnects an existing participant by participant id', async () => {
    const room = createRoomState('alpha-room');

    const original = (
      await room.join({
      socketId: 'socket-1',
        displayName: 'Alex'
      })
    ).participant;

    await room.updateParticipantMedia(original.id, {
      isCameraOn: true,
      isMicOn: true
    });
    await room.updateParticipantConnection(original.id, 'reconnecting');

    const rejoined = await room.reconnect(original.id, {
      socketId: 'socket-2',
      displayName: 'Alex'
    });

    expect(rejoined?.id).toBe(original.id);
    expect(rejoined?.socketId).toBe('socket-2');
    expect(rejoined?.connectionState).toBe('connected');
    expect(rejoined?.isCameraOn).toBe(true);
    expect(rejoined?.isMicOn).toBe(true);
    await expect(room.getParticipants()).resolves.toHaveLength(1);
  });
});
