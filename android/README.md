# PhotoCall Android

This is the native Android shell for PhotoCall. It loads the production PhotoCall frontend, requests camera/microphone permissions, and can launch Signal from the PhotoCall UI.

## Important Signal limitation

The Android Signal app does not expose a public API for a third-party app to replace Signal's video-call camera stream. Signal's documented Android call controls only allow disabling video or switching the phone camera; Desktop has a camera selector. Therefore this component does **not** claim to inject PhotoCall's avatar into an unmodified Signal Android call.

Android's platform virtual-camera service exists, but it is a system/virtual-device facility and is not a general public third-party camera API. A true production integration would require either Signal-side cooperation/a supported extension point or a custom Signal Android build that incorporates the PhotoCall video source.


## Signal connection behavior

The Android app exposes a native `PhotoCallAndroid.connectSignal()` bridge so the PhotoCall UI can launch the installed Signal Android application. This is a handoff/launch integration only. The official Signal Android application does not expose a public API for PhotoCall to replace its camera stream with the PhotoCall avatar. Signal documents only camera enable/disable and front/rear switching on Android. The PhotoCall avatar therefore remains available in PhotoCall/WebRTC; it is not injected into an unmodified Signal video call.
