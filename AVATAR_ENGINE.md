# PhotoCall Avatar Engine

PhotoCall uses a real browser facial-landmark deformation pipeline:

Photo
→ MediaPipe Face Landmarker
→ 400+ facial landmarks
→ reduced Delaunay facial mesh
→ eyes + eyebrows + lips + jaw + head deformation
→ generated Canvas video frames
→ `canvas.captureStream(30)`
→ WebRTC video track

## What was fixed in this upgrade

- The old `cdn.jsdelivr.net/.../+esm` dynamic import was removed.
- `@mediapipe/tasks-vision@1.0.1` is now a declared frontend dependency so Vite bundles the JavaScript engine during the production build.
- The WASM runtime and face-landmark model have CDN fallbacks.
- The backend discovery check now tests `/api/config`, which works with the Vercel serverless backend instead of incorrectly requiring `/health` or `/`.
- Backend Vercel routing now sends requests to the Node serverless entrypoint.
- Existing `backend/.env`, `backend/.env.sample`, `frontend/.env`, and `frontend/.env.sample` are retained in the project package.

## Result

After a clear human photo is uploaded, PhotoCall detects the face, builds the landmark mesh, and continuously generates animated frames. When the microphone is active, speech level drives mouth/jaw movement; blinking and subtle head motion continue even when the microphone is not active.

This is a **2D photo-puppet avatar engine**, not a generative neural-video model. It warps the original photo using facial landmarks, which makes the generated stream lightweight enough for browser/WebRTC use.

## Requirements

- Modern Chrome/Edge with WebGL/WebAssembly support
- HTTPS in production
- Clear, front-facing human photo with one visible face
- Internet access to the MediaPipe WASM runtime and model on first initialization

## Signal/native camera note

The WebRTC avatar stream is real and can be sent to another PhotoCall WebRTC peer. A normal Android application cannot silently replace Signal's native camera with an arbitrary WebView/canvas stream through public Android APIs. A true Signal camera replacement requires a device/OS-level virtual-camera architecture that Signal can select.
