plugins { id("com.android.application"); id("org.jetbrains.kotlin.android") }

android { namespace = "com.spworldtech.photocall"; compileSdk = 36
    defaultConfig { applicationId = "com.spworldtech.photocall"; minSdk = 26; targetSdk = 36; versionCode = 1; versionName = "5.0.0" }
}

dependencies { implementation("androidx.core:core-ktx:1.17.0"); implementation("androidx.appcompat:appcompat:1.7.1") }
