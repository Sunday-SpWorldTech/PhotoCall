# PhotoCall — Vercel production deployment

## Architecture

PhotoCall is a single Node.js + Express application with Socket.IO signaling, MongoDB persistence and WebRTC media. Vercel's current Fluid Compute WebSocket support can host Node WebSocket servers and Socket.IO; enable Fluid compute/WebSockets for the Vercel project if the dashboard asks for it.

## Required Vercel environment variables

Set these for Production, Preview and Development as appropriate:

```env
MONGODB_URI=mongodb+srv://...
JWT_SECRET=<new-random-secret>
JWT_EXPIRES_IN=7d
METERED_DOMAIN=https://photocallapp.metered.live
METERED_TURN_API_KEY=<new-turn-credential-api-key>
```

Optional uploaded-voice AI:

```env
ELEVENLABS_API_KEY=<server-side-elevenlabs-api-key>
ELEVENLABS_STS_MODEL=eleven_multilingual_sts_v2
```

Never expose the ElevenLabs API key, MongoDB password, JWT secret or Metered credential API key in frontend code.

## Backend Vercel project

For the dedicated backend project, keep the Vercel **Root Directory at the repository root** because the Vercel entrypoint is `server.ts`. Do not point this backend project at `frontend/`.

The root `server.ts` imports the CommonJS backend with a default import. This avoids the fragile named-import interop that can cause a deployed Node function to fail during initialization. The backend also no longer crashes at module load when a Vercel environment variable is missing; `/health` reports which required configuration is missing instead.

Required Production environment variables:

```env
CLIENT_URL=https://photocall-frontend.vercel.app
CORS_ORIGIN=https://photocall-frontend.vercel.app
PUBLIC_API_URL=https://photocall-backend.vercel.app
MONGODB_URI=<your MongoDB URI>
JWT_SECRET=<your JWT secret>
JWT_EXPIRES_IN=7d
METERED_DOMAIN=https://photocallapp.metered.live
METERED_TURN_API_KEY=<your Metered API key>
TURN_URL=turn:global.relay.metered.ca:443
TURN_USERNAME=<your Metered TURN username>
TURN_CREDENTIAL=<your Metered TURN credential>
ELEVENLABS_API_KEY=<your ElevenLabs key>
ELEVENLABS_STS_MODEL=eleven_multilingual_sts_v2
```

Do **not** put these secret values in GitHub, frontend code, or `VITE_*` variables. Add them in the Vercel backend project's **Environment Variables → Production** settings.

## Deploy

1. Push this repository to GitHub.
2. Import the repository into Vercel.
3. Keep the repository root as the Vercel Root Directory.
4. Select Node.js 24.x if Vercel asks.
5. Add the environment variables above.
6. Enable Vercel Fluid Compute/WebSockets for the project when prompted/available.
7. Deploy.
8. Open `/health` on the deployment URL.
9. Create two test accounts in two browsers/devices and test the same room.

## MongoDB Atlas

Allow the deployed Vercel application to reach MongoDB Atlas. Use the least-privileged database user required by this application.

## WebRTC

The browser obtains the ICE server list from `/api/config`. The backend fetches the credential-scoped Metered ICE configuration server-side and returns only the ICE configuration required by WebRTC.

## Uploaded voice

The optional uploaded-voice flow uses ElevenLabs Instant Voice Cloning and Speech-to-Speech. A user must explicitly choose the uploaded voice. The live browser microphone is converted in short segments, so this is a low-latency segmented voice-conversion mode, not zero-latency native voice cloning.

## Signal

Signal is not used as the WebRTC media transport. A third-party web application cannot simply replace Signal's native call media with its own WebRTC video track. PhotoCall's live media stays in PhotoCall/WebRTC.
