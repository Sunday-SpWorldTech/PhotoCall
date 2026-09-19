# PhotoCall Android companion

This is the native Android wrapper for PhotoCall. It loads the production PhotoCall frontend, requests normal camera/microphone capabilities through WebView, and provides a native Signal handoff through `PhotoCallAndroid.connectSignal()`.

## Important limitation

Android/Signal does not expose a public API that lets a third-party app replace Signal's outgoing camera stream with an arbitrary WebView/canvas stream. Therefore this project does **not** falsely claim to implement a Signal virtual camera. The actual PhotoCall avatar WebRTC call works inside PhotoCall; the Signal button opens/shares to Signal.

A true "PhotoCall avatar becomes Signal's camera" implementation requires a device/OS-supported virtual-camera mechanism accepted by Signal or a Signal-side integration; that is separate from a normal Android WebView app.
