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
