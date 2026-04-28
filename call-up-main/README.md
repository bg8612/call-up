# Mini Meet

Full-stack MVP for browser-based group calls with chat and screen sharing.

The current version is intentionally self-contained:

- React/Vite frontend
- Express + Socket.IO backend
- WebRTC mesh for small rooms
- in-memory room state and policy management

## Apps

- `apps/server` � Express + Socket.IO signaling/chat backend
- `apps/web` � React + Vite frontend with WebRTC mesh calls

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

Server environment example lives in `apps/server/.env.example`.

Important backend requirements:

- `SESSION_TOKEN_SECRET` is required in production.
- All backend instances must share the same `SESSION_TOKEN_SECRET`, otherwise reconnect tokens issued by one instance will be rejected by another.
- The current `local-room-broadcaster` and `local-signaling-delivery` adapters are process-local only.
- Multi-instance delivery still requires shared room storage plus a shared Socket.IO/broker adapter such as Redis.

## Realtime Backend Notes

- Room participants, chat history, socket sessions, reconnect timers, and room policy now go through explicit storage abstractions.
- Room policy is storage-backed; broader room metadata is still intentionally lightweight and not yet a full shared-room metadata model.
- `/health` includes realtime metrics and may return `degraded` when the backend observes delivery failures, timer saturation, rate-limit pressure, backpressure, signaling failures, or memory pressure.

## Implemented

- room join by name + room code
- multi-user audio/video calls
- in-call chat
- screen share with optional browser system audio support
- room owner policy toggles for chat, screen share, and system audio
- device selection for microphone and camera
