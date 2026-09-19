# PhotoCall Avatar Engine

PhotoCall's browser avatar pipeline is now a real facial-landmark deformation pipeline:

Photo
→ MediaPipe Face Landmarker
→ 400+ facial landmarks
→ reduced Delaunay facial mesh
→ lips / jaw / eyes / eyebrows / head deformation
→ Canvas generated frames
→ `canvas.captureStream(30)`
→ WebRTC video track

## Important

This is a 2D photo-puppet engine, not a generative neural video model. It uses the original pixels from the uploaded photo and warps them according to facial landmarks. This keeps the processing local in the browser and produces a real MediaStream that WebRTC can transmit.

The native Signal camera-source requirement is separate. The Android project can open Signal/share invites, but Android's normal third-party APIs do not let a regular app silently replace Signal's camera with an arbitrary virtual camera. A true Signal camera replacement requires an OS/device-level camera integration that Signal itself can select.

## Requirements

- Modern Chrome/Edge with WebGL/WebAssembly support
- HTTPS for microphone access in production
- A clear, front-facing human face for best results
- The MediaPipe model and WASM runtime are loaded from public CDNs at runtime
