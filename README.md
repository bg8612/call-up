# Mini Meet

Full-stack MVP for browser-based group calls with chat and screen sharing.

The current version is intentionally self-contained:

- React/Vite frontend
- Express + Socket.IO backend
- WebRTC mesh for small rooms
- in-memory room state and policy management

## Apps

- `apps/server` — Express + Socket.IO signaling/chat backend
- `apps/web` — React + Vite frontend with WebRTC mesh calls

## Development

```bash
npm install
npm run dev
```

Frontend: `http://localhost:5173`

Backend: `http://localhost:3001`

## Environment

Optional frontend environment:

```bash
VITE_SERVER_URL=http://localhost:3001
```

Development override is already included in `apps/web/.env.development`.

## Implemented

- room join by name + room code
- multi-user audio/video calls
- in-call chat
- screen share with optional browser system audio support
- room owner policy toggles for chat, screen share, and system audio
- device selection for microphone and camera
