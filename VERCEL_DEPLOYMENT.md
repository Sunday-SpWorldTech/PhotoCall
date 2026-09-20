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
