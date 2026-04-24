import { describe, expect, it } from 'vitest';
import { buildInviteLink, readPrefilledRoomId } from './invite-link';

describe('invite-link helpers', () => {
  it('builds an invite link with the room id in search params', () => {
    const result = buildInviteLink('https://localhost:5173/', 'team-sync');

    expect(result).toBe('https://localhost:5173/?room=team-sync');
  });

  it('reads the room id from the current location', () => {
    const result = readPrefilledRoomId('https://localhost:5173/?room=planning-room');

    expect(result).toBe('planning-room');
  });
});
