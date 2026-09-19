# PhotoCall — production deployment

## Backend

The backend Vercel project uses the repository root as its Root Directory. Vercel uses the root `server.ts` Node.js entrypoint, which exports the Express + Socket.IO HTTP server from `backend/server.js`. This is the current Vercel Node-server/WebSocket deployment pattern.

Production backend:

`https://photocall-backend.vercel.app`

Health check:

`https://photocall-backend.vercel.app/health`

Required backend environment variables are configured in the Vercel backend project, not committed to Git.

## Frontend

The frontend Vercel project uses the `frontend` directory as its Root Directory.

Production frontend:

`https://photocall-frontend.vercel.app`

Production variables:

```env
VITE_APP_NAME=PhotoCall
VITE_API_URL=https://photocall-backend.vercel.app
VITE_SOCKET_URL=https://photocall-backend.vercel.app
VITE_PRODUCTION_API_URL=https://photocall-backend.vercel.app
VITE_PRODUCTION_FRONTEND_URL=https://photocall-frontend.vercel.app
VITE_ENV=production
```

## Local development

Backend:

```powershell
cd "C:\Users\USER\PhotoCall\backend"
npm install
npm run dev
```

Frontend:

```powershell
cd "C:\Users\USER\PhotoCall\frontend"
npm install
npm run dev
```

Local environment values belong in the local `.env` files and are not required for the production Vercel URLs.

## Photo persistence

Authenticated JPEG, PNG and WebP avatars are stored in MongoDB and loaded after login.

## Calling

PhotoCall uses Socket.IO for signaling and WebRTC for PhotoCall's own media session. TURN/ICE configuration is obtained from `/api/config`.

## Signal on Android

The native Android shell provides two supported handoff actions:

- **Connect Signal** launches the installed Signal Android app.
- **Share in Signal** sends the PhotoCall room invitation through Signal's Android share intent.

The official Signal Android application does not expose a public API for a third-party app to replace Signal's camera stream. Therefore PhotoCall does not falsely claim to inject the PhotoCall avatar into an unmodified Signal call. The PhotoCall avatar remains the media source for PhotoCall/WebRTC.
