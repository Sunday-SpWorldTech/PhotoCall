# PhotoCall

Production-oriented human-avatar WebRTC calling application.

## Features

- Account registration/login with JWT + bcrypt
- MongoDB call/session persistence
- Socket.IO authenticated signaling
- Metered STUN/TURN ICE configuration
- Upload and human-face validation for a caller avatar
- Independent avatar ON/OFF choice
- Independent uploaded-voice ON/OFF choice
- Optional ElevenLabs Instant Voice Clone + Speech-to-Speech conversion
- Browser voice effects when uploaded voice is disabled
- WebRTC peer media with avatar canvas and processed/converted audio
- Vercel Node.js + WebSocket entrypoint (`server.ts`)

## Important

The uploaded-voice feature requires `ELEVENLABS_API_KEY`. Without it, the core WebRTC calling app still works, but uploaded voice cloning/conversion is disabled.

The app does not replace or inject its camera stream into the native Signal call. Signal is used as an external handoff/share channel; the live PhotoCall avatar media is carried by PhotoCall/WebRTC. On Android, the PhotoCall shell can open Signal and share the PhotoCall room invitation.

See `VERCEL_DEPLOYMENT.md` for deployment.
