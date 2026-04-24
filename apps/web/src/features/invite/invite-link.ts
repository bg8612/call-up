export const buildInviteLink = (origin: string, roomId: string) => {
  const url = new URL(origin);
  url.searchParams.set('room', roomId.trim());
  return url.toString();
};

export const readPrefilledRoomId = (href: string) => {
  const url = new URL(href);
  return url.searchParams.get('room')?.trim() ?? '';
};
