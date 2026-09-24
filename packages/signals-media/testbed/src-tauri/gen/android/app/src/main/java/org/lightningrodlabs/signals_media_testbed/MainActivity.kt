package org.lightningrodlabs.signals_media_testbed

import android.Manifest
import android.content.pm.PackageManager
import android.os.Bundle
import androidx.activity.enableEdgeToEdge
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat

/**
 * The testbed activity.
 *
 * The only thing it adds to the generated template is a **pre-grant** of the
 * two dangerous media permissions.
 *
 * wry already handles the webview side: `RustWebChromeClient.onPermissionRequest`
 * (wry 0.55.1, `src/android/kotlin/RustWebChromeClient.kt:94-119`) maps
 * `android.webkit.resource.AUDIO_CAPTURE` -> RECORD_AUDIO + MODIFY_AUDIO_SETTINGS
 * and `VIDEO_CAPTURE` -> CAMERA, launches the OS request through its own
 * `ActivityResultLauncher`, and calls `request.grant(request.resources)` when
 * the user allows. So `getUserMedia` works with NO WebChromeClient of our own
 * — the manifest entries alone are the functional requirement.
 *
 * What this adds is timing. wry launches its request from inside the
 * `getUserMedia` call, i.e. in the middle of an `auto=1` run: the first launch
 * on a fresh install would stall the run behind a dialog. Asking in `onCreate`
 * means the dialog is answered before the page is interactive, and every later
 * launch is dialog-free because Android remembers the grant — which is what
 * makes the scripted `adb logcat` run non-interactive.
 *
 * It is a request, not a guarantee: wry still runs its own request afterwards
 * (it does not check `hasPermissions` first). While the pre-grant dialog is
 * still open, that second request can come back denied without ever being
 * shown, and `getUserMedia` then rejects with NotAllowedError. That is what
 * the page's `gumretry=<seconds>` parameter is for — the Android runs pass
 * `gumretry=30`, so the first attempt after the grant succeeds.
 */
class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    // After super.onCreate, deliberately. enableEdgeToEdge is documented to
    // run before it; requestPermissions has no such contract, and calling it
    // on a half-constructed activity would risk a launch crash to buy
    // nothing: the webview `super.onCreate` builds still has to load the page
    // and wait out its 500 ms auto-start, so the dialog comes first anyway,
    // and `gumretry` covers the case where it does not.
    requestMediaPermissions()
  }

  /**
   * Ask for RECORD_AUDIO and CAMERA if we do not already hold them.
   * MODIFY_AUDIO_SETTINGS is a normal permission: declaring it in the manifest
   * is the whole of it, there is nothing to request at runtime.
   */
  private fun requestMediaPermissions() {
    val wanted = arrayOf(Manifest.permission.RECORD_AUDIO, Manifest.permission.CAMERA)
    val missing = wanted.filter {
      ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED
    }
    if (missing.isNotEmpty()) {
      ActivityCompat.requestPermissions(this, missing.toTypedArray(), MEDIA_PERMISSION_REQUEST)
    }
  }

  companion object {
    private const val MEDIA_PERMISSION_REQUEST = 1
  }
}
