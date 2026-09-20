# PhotoCall production fixes

This build fixes the two failure classes shown in the deployed UI:

1. **Avatar rendering**
   - Corrected the face-mesh source-to-target affine rendering.
   - The previous renderer cropped the source image while applying a transform defined in full-canvas coordinates, which produced the large translucent polygon/double-face effect.
   - Reduced excessive head displacement and expression scaling so the uploaded face stays aligned with the original head.
   - Kept real MediaPipe Face Landmarker tracking for eyes, eyebrows, lips, jaw and head movement.
   - Kept the live camera preview and 30 FPS canvas capture path for WebRTC.

2. **Backend / Failed to fetch**
   - Added a same-origin `/api` backend deployment path so the frontend does not depend on a separately named Vercel backend project.
   - Frontend API calls now try `/api` first and can fall back to configured API URLs.
   - Voice upload, voice conversion and voice testing use the same backend fallback logic instead of failing with a generic browser `Failed to fetch` message.
   - Vercel configuration now builds `frontend/` while exposing `api/index.js` from the same project.
   - CORS accepts Vercel HTTPS deployment origins.

## Important deployment requirement

Deploy the **PhotoCall project root** to Vercel, not only the `frontend` folder. The root contains `vercel.json` and `api/index.js` so `/api/health`, `/api/voice/clone`, and `/api/rooms/...` are served by the same Vercel deployment.

For real voice cloning and persistent calling/signaling, configure the backend environment variables in Vercel, especially `MONGODB_URI` and `ELEVENLABS_API_KEY`. TURN credentials should also be configured for networks where STUN alone cannot establish a peer-to-peer connection.

Do not expose API secrets in the browser. Keep provider keys in backend/server environment variables.
