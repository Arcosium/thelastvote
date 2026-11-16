package uk.aive.thelastvote

import android.annotation.SuppressLint
import android.content.ContentValues
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Color
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.provider.MediaStore
import android.util.Base64
import android.view.View
import android.webkit.CookieManager
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.splashscreen.SplashScreen.Companion.installSplashScreen
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import uk.aive.thelastvote.databinding.ActivityMainBinding
import kotlin.concurrent.thread

class MainActivity : AppCompatActivity() {
    private lateinit var binding: ActivityMainBinding
    private var loaded = false
    private var lastBack = 0L
    private val webUrl = "https://thelastvote.ai-ve.uk"
    private val host = "thelastvote.ai-ve.uk"
    private val savableTypes = mapOf("png" to "image/png", "json" to "application/json")
    private var pendingSave: ByteArray? = null
    private val pickSaveTarget = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        val bytes = pendingSave
        pendingSave = null
        val uri = result.data?.data
        if (result.resultCode == RESULT_OK && uri != null && bytes != null) thread { write(uri, bytes, "파일을 저장했습니다") }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        val splash = installSplashScreen()
        splash.setKeepOnScreenCondition { !loaded }
        super.onCreate(savedInstanceState)
        WindowCompat.setDecorFitsSystemWindows(window, false)
        window.statusBarColor = Color.TRANSPARENT
        window.navigationBarColor = Color.parseColor("#090B0C")
        WindowInsetsControllerCompat(window, window.decorView).apply {
            isAppearanceLightStatusBars = false
            isAppearanceLightNavigationBars = false
        }
        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)
        ViewCompat.setOnApplyWindowInsetsListener(binding.root) { view, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
            val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
            view.setPadding(bars.left, bars.top, bars.right, maxOf(bars.bottom, ime.bottom))
            insets
        }
        setupWebView()
        setupBack()
        binding.btnRetry.setOnClickListener { if (online()) load(webUrl) else showError() }
        val restored = savedInstanceState != null && binding.webView.restoreState(savedInstanceState) != null
        if (restored) loaded = true else if (online()) load(launchUrl(intent)) else showError()
    }

    private fun launchUrl(incoming: Intent?): String {
        val uri = incoming?.data ?: return webUrl
        return if (uri.scheme == "https" && uri.host == host) uri.toString() else webUrl
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        // 런처 아이콘으로 돌아올 때는 진행 중인 화면을 그대로 둔다. 링크로 열렸을 때만 그 주소를 연다.
        if (intent.data != null) load(launchUrl(intent))
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun setupWebView() = with(binding.webView) {
        setBackgroundColor(Color.parseColor("#090B0C"))
        settings.javaScriptEnabled = true
        settings.domStorageEnabled = true
        settings.cacheMode = WebSettings.LOAD_DEFAULT
        settings.setSupportZoom(false)
        settings.mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
        settings.userAgentString = "${settings.userAgentString} TheLastVoteApp/1.0"
        CookieManager.getInstance().setAcceptCookie(true)
        addJavascriptInterface(AppBridge(), "TheLastVoteApp")
        webChromeClient = object : WebChromeClient() {
            override fun onProgressChanged(view: WebView?, progress: Int) {
                binding.progressBar.progress = progress
                binding.progressBar.visibility = if (progress < 100) View.VISIBLE else View.GONE
            }
        }
        webViewClient = object : WebViewClient() {
            override fun onPageStarted(view: WebView?, url: String?, icon: Bitmap?) {
                binding.progressBar.visibility = View.VISIBLE
            }
            override fun onPageFinished(view: WebView?, url: String?) {
                loaded = true
                binding.progressBar.visibility = View.GONE
                CookieManager.getInstance().flush()
            }
            override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean {
                val url = request?.url ?: return false
                if (url.scheme == "https" && url.host == host) return false
                if (url.scheme in setOf("https", "http", "mailto")) {
                    runCatching { startActivity(Intent(Intent.ACTION_VIEW, url)) }
                        .onFailure { Toast.makeText(this@MainActivity, "연결할 앱을 찾을 수 없습니다", Toast.LENGTH_SHORT).show() }
                }
                return true
            }
            override fun onReceivedError(view: WebView?, request: WebResourceRequest?, error: WebResourceError?) {
                if (request?.isForMainFrame == true) showError()
            }
        }
        isVerticalScrollBarEnabled = false
        overScrollMode = View.OVER_SCROLL_NEVER
    }

    private fun setupBack() {
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                // 웹 화면에 열린 창이 있으면 그것부터 닫는다. 닫을 창이 없을 때만 기존 동작을 한다.
                binding.webView.evaluateJavascript("!!(window.TheLastVoteBack&&window.TheLastVoteBack())") { closed ->
                    if (closed != "true") handleRegularBack()
                }
            }
        })
    }

    private fun handleRegularBack() {
        if (binding.webView.canGoBack()) { binding.webView.goBack(); return }
        val now = System.currentTimeMillis()
        if (now - lastBack < 2000) { finish(); return }
        lastBack = now
        Toast.makeText(this, "한 번 더 누르면 종료됩니다", Toast.LENGTH_SHORT).show()
    }

    // 웹뷰는 파일 내려받기를 처리하지 못하므로, 게임 화면이 넘긴 결과 카드·기록 파일을 직접 저장한다.
    private inner class AppBridge {
        @JavascriptInterface
        fun saveFile(name: String, mime: String, base64: String) {
            val type = savableTypes[name.substringAfterLast('.', "")]
            val bytes = runCatching { Base64.decode(base64, Base64.DEFAULT) }.getOrNull()
            runOnUiThread {
                val fromGame = Uri.parse(binding.webView.url ?: "").host == host
                val valid = type != null && type == mime && Regex("[A-Za-z0-9._-]{1,80}").matches(name) &&
                    bytes != null && bytes.isNotEmpty() && bytes.size <= 20 * 1024 * 1024
                if (!fromGame) return@runOnUiThread
                if (valid) save(name, mime, bytes!!) else toast("저장하지 못했습니다")
            }
        }
    }

    private fun save(name: String, mime: String, bytes: ByteArray) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            // 저장 제공자가 느리면 화면이 멈추므로 파일 만들기·쓰기·지우기는 작업 스레드에서 한다.
            thread {
                val values = ContentValues().apply {
                    put(MediaStore.Downloads.DISPLAY_NAME, name)
                    put(MediaStore.Downloads.MIME_TYPE, mime)
                    put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS)
                }
                val uri = runCatching { contentResolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values) }.getOrNull()
                if (uri == null) { toast("저장하지 못했습니다"); return@thread }
                if (!write(uri, bytes, "다운로드 폴더에 저장했습니다")) runCatching { contentResolver.delete(uri, null, null) }
            }
        } else {
            // 안드로이드 8~9는 권한 없이 다운로드 폴더에 쓸 수 없어 저장 위치를 고르게 한다.
            // ponytail: 고르는 동안 앱이 내려가면 pendingSave가 사라져 저장되지 않는다. 문제가 되면 캐시 파일로 옮긴다.
            pendingSave = bytes
            val pick = Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType(mime).putExtra(Intent.EXTRA_TITLE, name)
            runCatching { pickSaveTarget.launch(pick) }.onFailure { pendingSave = null; toast("저장하지 못했습니다") }
        }
    }

    // 작업 스레드에서 부른다.
    private fun write(uri: Uri, bytes: ByteArray, done: String): Boolean {
        val ok = runCatching { contentResolver.openOutputStream(uri)!!.use { it.write(bytes) } }.isSuccess
        toast(if (ok) done else "저장하지 못했습니다")
        return ok
    }

    private fun toast(message: String) = runOnUiThread { Toast.makeText(this, message, Toast.LENGTH_SHORT).show() }

    // 홈으로 나가거나 다른 앱으로 가면 웹 화면에 가려졌다고 알려 배경음이 멈추게 한다.
    override fun onPause() {
        binding.webView.onPause()
        super.onPause()
    }

    override fun onResume() {
        super.onResume()
        binding.webView.onResume()
    }

    private fun load(url: String) {
        binding.errorContainer.visibility = View.GONE
        binding.webView.visibility = View.VISIBLE
        binding.webView.loadUrl(url)
    }
    private fun showError() {
        loaded = true
        binding.webView.visibility = View.GONE
        binding.errorContainer.visibility = View.VISIBLE
        binding.progressBar.visibility = View.GONE
    }
    private fun online(): Boolean {
        val manager = getSystemService(ConnectivityManager::class.java)
        val network = manager.activeNetwork ?: return false
        return manager.getNetworkCapabilities(network)?.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) == true
    }
    override fun onSaveInstanceState(outState: Bundle) {
        binding.webView.saveState(outState)
        super.onSaveInstanceState(outState)
    }
}
