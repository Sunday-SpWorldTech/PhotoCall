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

## Current avatar-control architecture

The browser uses MediaPipe Face Landmarker to track the user's live face. The uploaded portrait is retained as the visual identity while a reduced facial mesh is warped from the target photo's neutral landmarks toward the user's live landmarks. Rendering is throttled to 30 FPS and the source image is cropped to the face region for performance. Blendshape scores are used as additional signals for jaw opening and blinking. The mouth is rendered with an expression overlay when the user's jaw opens so a closed-mouth source image can visibly open during speech.

The camera preview is shown while face control is active so the user can confirm that the webcam is actually driving the avatar.

This is a real-time 2D photo-puppet system, not a generative talking-head model. A single photograph cannot reveal unseen teeth, tongue, hair, or back-of-head information; a production system that needs photorealistic novel views would require a dedicated generative/3D avatar model.
