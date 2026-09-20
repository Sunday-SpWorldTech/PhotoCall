# PhotoCall Avatar Engine

PhotoCall uses a browser-side 2D human-photo puppet. The uploaded photo remains the identity texture, while the user's live camera controls the facial mesh.

## Runtime pipeline

Photo
→ MediaPipe Face Landmarker (478 points)
→ neutral photo face mesh
→ user's webcam face tracking
→ expression/head deltas
→ face-mesh deformation
→ Canvas animation
→ `canvas.captureStream(30)`
→ WebRTC video track
→ partner

Audio is separate:

Microphone
→ Web Audio processing
→ optional authorized voice conversion
→ WebRTC audio track

## Face control

After a valid photo is detected, PhotoCall requests camera access. The first good camera frame is used as the neutral control pose. Subsequent frames drive the corresponding photo landmarks, including head translation, eyes, eyebrows, lips, jaw and mouth opening.

If camera permission is denied, the uploaded photo can still be previewed, but it cannot be controlled by the user's face until camera access is enabled.

## MediaPipe

PhotoCall uses the published `@mediapipe/tasks-vision` 1.0.1 release. It uses a CDN ESM loader with a fallback ESM host so the application does not depend on the invalid `0.10.22` package URL that caused the previous initialization error.

## Important scope

This is a real-time 2D photo-puppet system, not a generative photorealistic video model. It deforms the uploaded person's pixels. A separate generative-video model would be required to synthesize new photorealistic frames outside the source photo.

## Calling

The generated canvas is captured as a WebRTC video track. REST polling is used only for signaling. Production calls require a working MongoDB connection for signaling persistence and a TURN service for restrictive networks.
