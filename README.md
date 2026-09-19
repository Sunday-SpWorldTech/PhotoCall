# PhotoCall

PhotoCall is a direct-access browser calling app. Users do not register or sign in. They upload a human photo, optionally configure an uploaded voice, start the microphone, and use a shared room code for a live WebRTC call.

## Architecture
- `server.js` / `backend/server.js`: Express + Socket.IO backend for Vercel.
- `frontend/`: Vite frontend deployed separately.
- Photo/avatar rendering stays in the browser.
- Socket.IO handles signaling; WebRTC carries audio/video.
- Signal is used to send the room invitation.
- MongoDB and JWT are not required for the direct-access core.

## Vercel
Deploy the repository root as the backend project so Vercel detects the root `server.js`. Deploy `frontend/` as the frontend project. See `VERCEL_DEPLOYMENT.md`.
