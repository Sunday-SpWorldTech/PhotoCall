# PhotoCall — Vercel production deployment

## Architecture

PhotoCall uses a Vercel Node.js Function running Express + Socket.IO, MongoDB for persistence, Metered for WebRTC ICE/TURN configuration, and optional ElevenLabs uploaded-voice processing. Vercel supports WebSocket connections on Fluid Compute; enable Fluid Compute/WebSockets for the backend project if the dashboard presents that option.

## Backend project

Use the repository root as the Vercel Root Directory and deploy `server.ts` as the backend function. The function exports the HTTP server created by `backend/server.js`.

## Required Production environment variables

Set these in the **backend Vercel project only**:

```env
CLIENT_URL=https://photocall-frontend.vercel.app
CORS_ORIGIN=https://photocall-frontend.vercel.app
MONGODB_URI=<your MongoDB URI>
JWT_SECRET=<new random secret>
JWT_EXPIRES_IN=7d
TURN_URL=turn:global.relay.metered.ca:443
TURN_USERNAME=<your Metered username>
TURN_CREDENTIAL=<your Metered credential>
METERED_DOMAIN=https://photocallapp.metered.live
METERED_TURN_API_KEY=<your Metered credential API key>
ELEVENLABS_API_KEY=<server-side key, optional>
ELEVENLABS_STS_MODEL=eleven_multilingual_sts_v2
```

Never put MongoDB, JWT, Metered API or ElevenLabs secrets in the frontend or GitHub.

## Frontend project

Set these in the **frontend Vercel project**:

```env
VITE_APP_NAME=PhotoCall
VITE_API_URL=https://photocall-backend.vercel.app
VITE_SOCKET_URL=https://photocall-backend.vercel.app
VITE_PRODUCTION_API_URL=https://photocall-backend.vercel.app
VITE_PRODUCTION_FRONTEND_URL=https://photocall-frontend.vercel.app
VITE_ENV=production
```

## Verification

After deployment, open:

`https://photocall-backend.vercel.app/health`

It returns configuration diagnostics without requiring a MongoDB connection. Missing required configuration is reported by name rather than causing an opaque initialization crash.

## Photo persistence

Uploaded JPEG/PNG/WebP avatars are stored in the authenticated user's MongoDB document and loaded again after login, so the selected human photo is not lost on browser refresh.

## Calling

Socket.IO performs signaling and WebRTC carries the audio/video media. The browser obtains the Metered ICE server list from `/api/config`.

## Signal

Signal cannot be used by a third-party PhotoCall website as the media transport for PhotoCall's custom avatar WebRTC track. The app can share a PhotoCall invitation through the device's share sheet where Signal is available, while the actual PhotoCall media remains in PhotoCall/WebRTC.
