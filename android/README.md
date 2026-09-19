# PhotoCall Android companion

This Android project is **not deployed to Vercel**. It is built as an APK/AAB and installed on an Android device.

It currently provides:

- PhotoCall WebView client on Android.
- Camera and microphone runtime permissions.
- `<input type="file">` support for photo/voice uploads.
- Signal app launch/share companion behavior.

## Build

Open `android/PhotoCallMobile` in Android Studio and build an APK.

## Important native Signal limitation

A normal third-party Android application cannot silently replace Signal's camera with a custom WebView/canvas stream through the public Android APIs. The PhotoCall web avatar can produce a real WebRTC video stream, but making that stream appear as Signal's native camera requires a separate device-level camera provider/virtual-camera architecture that Signal and the Android OS must accept.
