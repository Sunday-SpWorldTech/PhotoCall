# PhotoCall Avatar Engine

PhotoCall uses a browser-side 2D facial-puppet pipeline for the uploaded human photo.

## Runtime pipeline

Photo
→ MediaPipe Face Landmarker
→ 478-point facial mesh
→ stable face rig
→ eyes/blink + eyebrows + lips/jaw + head motion
→ Canvas animation at 30 FPS
→ `canvas.captureStream(30)`
→ WebRTC video track

The preview intentionally animates without a microphone so a newly uploaded photo does not remain visually static. When the microphone is active, audio energy becomes the primary mouth-opening driver.

## MediaPipe version

The frontend uses the current stable `@mediapipe/tasks-vision` CDN release `1.0.1`. The previous `0.10.22` URL was invalid because `0.10.22` was not published as a stable package release.

## Scope

This is a 2D photo-puppet avatar, not a generative deepfake/video synthesis model. It preserves the uploaded person's pixels and warps facial regions using the detected landmark mesh. A separate generative-video provider would be required for photorealistic new frames outside the source image texture.
