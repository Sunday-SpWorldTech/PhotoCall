# PhotoCall Vercel Deployment

PhotoCall is intentionally split into two Vercel deployments:

- Frontend project root: `frontend/`
- Backend project root: `backend/`

## Frontend environment

Set these in the frontend Vercel project:

- `VITE_API_URL=https://photocall-backend.vercel.app`
- `VITE_PRODUCTION_API_URL=https://photocall-backend.vercel.app`
- `VITE_PRODUCTION_FRONTEND_URL=https://photocall-frontend.vercel.app`

## Backend environment

Set these in the backend Vercel project:

- `MONGODB_URI`
- `JWT_SECRET`
- `CLIENT_URL`
- `CORS_ORIGIN`
- `PUBLIC_API_URL`
- TURN credentials (`METERED_DOMAIN` + `METERED_TURN_API_KEY`, or TURN_URL/username/credential)
- Optional ElevenLabs credentials for uploaded-voice conversion

Do not put production secrets in `.env.sample` or in the frontend bundle.

## Health check

Open `/health` on the backend deployment. `database: "connected"` is required for room signaling. If the database is unavailable, PhotoCall keeps the avatar engine available but calls/signaling are intentionally reported as unavailable instead of showing a fake successful connection.

## Current deployment checks

1. Deploy the backend project from the `backend` directory and confirm `/health` returns HTTP 200.
2. Deploy the frontend project from the `frontend` directory.
3. Set the frontend `VITE_API_URL` and `VITE_PRODUCTION_API_URL` to the actual backend deployment URL.
4. Set backend `CLIENT_URL`/`CORS_ORIGIN` to the production frontend URL. The backend also accepts Vercel preview URLs matching the PhotoCall frontend naming pattern.
5. Open the frontend, upload a clear front-facing photo, click **Start face control**, allow camera permission, and verify that the camera preview appears.
6. Move the user's head, blink, raise eyebrows, and open the mouth. The uploaded photo should visibly deform at the corresponding facial regions.
7. Start the microphone and use **Test voice** before starting a call.
8. Only then test WebRTC signaling with a second browser/device.
