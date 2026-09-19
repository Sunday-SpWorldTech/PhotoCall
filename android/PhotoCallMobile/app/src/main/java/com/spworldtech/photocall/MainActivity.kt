package com.spworldtech.photocall

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Bundle
import android.webkit.PermissionRequest
import android.webkit.WebChromeClient
import android.webkit.WebView
import android.webkit.WebViewClient
import android.webkit.JavascriptInterface
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat

class MainActivity : ComponentActivity() {
    private lateinit var web: WebView
    private val url = "https://photocall-frontend.vercel.app"
    private val signalPackage = "org.thoughtcrime.securesms"

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        web = WebView(this)
        setContentView(web)
        requestMediaPermissions()
        web.settings.javaScriptEnabled = true
        web.settings.domStorageEnabled = true
        web.settings.mediaPlaybackRequiresUserGesture = false
        web.addJavascriptInterface(SignalBridge(), "PhotoCallAndroid")
        web.webViewClient = object : WebViewClient() {}
        web.webChromeClient = object : WebChromeClient() {
            override fun onPermissionRequest(request: PermissionRequest) {
                runOnUiThread { request.grant(request.resources) }
            }
        }
        web.loadUrl(url)
    }

    private fun requestMediaPermissions() {
        val missing = arrayOf(Manifest.permission.CAMERA, Manifest.permission.RECORD_AUDIO)
            .filter { ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED }
        if (missing.isNotEmpty()) ActivityCompat.requestPermissions(this, missing.toTypedArray(), 100)
    }

    inner class SignalBridge {
        @JavascriptInterface
        fun connectSignal() {
            runOnUiThread { openSignal() }
        }

        @JavascriptInterface
        fun shareToSignal(text: String) {
            runOnUiThread { shareTextToSignal(text) }
        }
    }

    private fun shareTextToSignal(text: String) {
        try {
            val intent = Intent(Intent.ACTION_SEND).apply {
                type = "text/plain"
                putExtra(Intent.EXTRA_TEXT, text)
                setPackage(signalPackage)
            }
            if (intent.resolveActivity(packageManager) != null) {
                startActivity(intent)
            } else {
                Toast.makeText(this, "Signal is not installed.", Toast.LENGTH_LONG).show()
            }
        } catch (e: Exception) {
            Toast.makeText(this, "Unable to share to Signal.", Toast.LENGTH_LONG).show()
        }
    }

    fun openSignal() {
        try {
            val launch = packageManager.getLaunchIntentForPackage(signalPackage)
            if (launch != null) startActivity(launch)
            else startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("https://signal.org/download/android/")))
        } catch (e: Exception) {
            Toast.makeText(this, "Signal could not be opened.", Toast.LENGTH_LONG).show()
        }
    }
}
