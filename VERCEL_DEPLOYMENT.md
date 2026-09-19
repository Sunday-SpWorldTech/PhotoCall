# PhotoCall production deployment

## Backend Vercel project

Deploy the repository root as the backend project. The Vercel entrypoint is `server.js`, which exports the Express app directly.

Set these environment variables in Vercel:

- `CLIENT_URL=https://photocall-frontend.vercel.app`
- `CORS_ORIGIN=https://photocall-frontend.vercel.app`
- `PUBLIC_API_URL=https://photocall-backend.vercel.app`
- `MONGODB_URI=<your MongoDB URI>`
- `TURN_URL=<your Metered TURN URL>`
- `TURN_USERNAME=<your Metered username>`
- `TURN_CREDENTIAL=<your Metered credential>`
- `METERED_DOMAIN=https://photocallapp.metered.live`
- `METERED_TURN_API_KEY=<your Metered API key>`
- `ELEVENLABS_API_KEY=<your ElevenLabs API key>`
- `ELEVENLABS_STS_MODEL=eleven_multilingual_sts_v2`

`JWT_SECRET` may remain configured for compatibility, but direct-access mode does not require login/JWT.

## Frontend Vercel project

Set the root directory to `frontend` and set:

`VITE_API_URL=https://photocall-backend.vercel.app`

`VITE_PRODUCTION_API_URL=https://photocall-backend.vercel.app`

`VITE_PRODUCTION_FRONTEND_URL=https://photocall-frontend.vercel.app`

## Verification

Open the backend URL first. It should return JSON from `/`, and `/health` should report `database: connected` when MongoDB is configured correctly.

The calling path uses REST polling + MongoDB for signaling rather than a process-local Socket.IO room. This avoids relying on a long-lived Node process or in-memory room state in Vercel serverless deployments.
