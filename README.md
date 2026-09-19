# PhotoCall

PhotoCall is a real-time human-photo avatar WebRTC application.

## Architecture

- `frontend/` — Vite web client and local facial-landmark avatar engine.
- `backend/` — Express API, MongoDB-backed REST signaling, Metered TURN lookup and optional ElevenLabs voice processing.
- `android/PhotoCallMobile/` — native Android companion for device-level integration and Signal sharing.

## Avatar pipeline

Photo → face detection → 400+ facial landmarks → facial mesh → animated lips/jaw/eyes/brows/head → generated canvas frames → WebRTC video track.

See `AVATAR_ENGINE.md` for limitations and the native Signal integration boundary.
