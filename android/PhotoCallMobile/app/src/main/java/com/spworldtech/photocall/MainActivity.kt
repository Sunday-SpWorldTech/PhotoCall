package com.spworldtech.photocall

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.appcompat.app.AppCompatActivity

class MainActivity : AppCompatActivity() {
    private lateinit var web: WebView
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        web = WebView(this)
        web.settings.javaScriptEnabled = true
        web.settings.domStorageEnabled = true
        web.settings.mediaPlaybackRequiresUserGesture = false
        web.webViewClient = WebViewClient()
        web.webChromeClient = WebChromeClient()
        web.addJavascriptInterface(SignalBridge(), "PhotoCallAndroid")
        setContentView(web)
        web.loadUrl("https://photocall-frontend.vercel.app")
    }
    inner class SignalBridge {
        @JavascriptInterface fun connectSignal() {
            runOnUiThread {
                val intent = packageManager.getLaunchIntentForPackage("org.thoughtcrime.securesms")
                    ?: Intent(Intent.ACTION_VIEW, Uri.parse("https://signal.org/android/"))
                startActivity(intent)
            }
        }
    }
}
