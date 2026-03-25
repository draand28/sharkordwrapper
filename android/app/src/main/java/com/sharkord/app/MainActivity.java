package com.sharkord.app;

import android.Manifest;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.media.AudioAttributes;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
import android.net.Uri;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.Bundle;
import android.view.WindowManager;
import android.webkit.CookieManager;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import androidx.annotation.NonNull;
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;

import java.util.ArrayList;
import java.util.List;

public class MainActivity extends AppCompatActivity {

    private static final int PERMISSION_REQUEST_CODE = 100;
    private static final String PREFS_NAME = "SharkordPrefs";
    private static final String KEY_URL = "sharkord_url";

    private WebView webView;
    private boolean serviceRunning = false;
    private WifiManager.WifiLock wifiLock;
    private AudioManager audioManager;
    private AudioFocusRequest audioFocusRequest;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        getWindow().setStatusBarColor(0xFF0F0F23);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        setContentView(R.layout.activity_main);

        webView = findViewById(R.id.webview);
        setupWebView();
        requestPermissions();

        String savedUrl = getPrefs().getString(KEY_URL, null);
        if (savedUrl != null && !savedUrl.isEmpty()) {
            webView.loadUrl(savedUrl);
            startKeepAlive();
        } else {
            webView.loadUrl("file:///android_asset/setup.html");
        }
    }

    private SharedPreferences getPrefs() {
        return getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
    }

    // ── Keep-alive: service + wifi lock + audio focus ───────────────────────
    private void startKeepAlive() {
        // Foreground service
        if (!serviceRunning) {
            Intent serviceIntent = new Intent(this, KeepAliveService.class);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                startForegroundService(serviceIntent);
            } else {
                startService(serviceIntent);
            }
            serviceRunning = true;
        }

        // Wifi lock — prevent wifi from going to low-power mode
        if (wifiLock == null) {
            WifiManager wifiManager = (WifiManager) getApplicationContext().getSystemService(Context.WIFI_SERVICE);
            if (wifiManager != null) {
                wifiLock = wifiManager.createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "sharkord:wifi");
                wifiLock.acquire();
            }
        }

        // Audio focus — tells Android this app is actively playing audio,
        // prevents the system from suspending audio pipelines
        acquireAudioFocus();

        // Tell the WebView renderer to stay at high priority even in background
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            webView.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false);
        }
    }

    private void stopKeepAlive() {
        if (serviceRunning) {
            stopService(new Intent(this, KeepAliveService.class));
            serviceRunning = false;
        }
        if (wifiLock != null && wifiLock.isHeld()) {
            wifiLock.release();
            wifiLock = null;
        }
        abandonAudioFocus();
    }

    private void acquireAudioFocus() {
        audioManager = (AudioManager) getSystemService(Context.AUDIO_SERVICE);
        if (audioManager == null) return;

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            AudioAttributes attrs = new AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                    .build();
            audioFocusRequest = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
                    .setAudioAttributes(attrs)
                    .setWillPauseWhenDucked(false)
                    .setAcceptsDelayedFocusGain(true)
                    .setOnAudioFocusChangeListener(focusChange -> {})
                    .build();
            audioManager.requestAudioFocus(audioFocusRequest);
        } else {
            audioManager.requestAudioFocus(
                    focusChange -> {},
                    AudioManager.STREAM_VOICE_CALL,
                    AudioManager.AUDIOFOCUS_GAIN
            );
        }

        // Route audio through voice call stream for consistent behavior
        audioManager.setMode(AudioManager.MODE_IN_COMMUNICATION);
    }

    private void abandonAudioFocus() {
        if (audioManager == null) return;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && audioFocusRequest != null) {
            audioManager.abandonAudioFocusRequest(audioFocusRequest);
        }
        audioManager.setMode(AudioManager.MODE_NORMAL);
    }

    // ── WebView setup ───────────────────────────────────────────────────────
    private void setupWebView() {
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);
        settings.setAllowFileAccess(true);
        settings.setAllowContentAccess(true);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        settings.setUserAgentString(settings.getUserAgentString() + " SharkordAndroid/1.0");

        // Keep the offscreen renderer active
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            settings.setOffscreenPreRaster(true);
        }

        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(webView, true);

        webView.addJavascriptInterface(new SetupBridge(), "SharkordBridge");

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                String savedUrl = getPrefs().getString(KEY_URL, "");

                if (!savedUrl.isEmpty()) {
                    try {
                        Uri savedUri = Uri.parse(savedUrl);
                        Uri targetUri = request.getUrl();
                        if (savedUri.getHost() != null && savedUri.getHost().equals(targetUri.getHost())) {
                            return false;
                        }
                    } catch (Exception ignored) {}
                }

                Intent intent = new Intent(Intent.ACTION_VIEW, request.getUrl());
                startActivity(intent);
                return true;
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(final PermissionRequest request) {
                runOnUiThread(() -> request.grant(request.getResources()));
            }
        });
    }

    private void requestPermissions() {
        List<String> permissions = new ArrayList<>();
        permissions.add(Manifest.permission.CAMERA);
        permissions.add(Manifest.permission.RECORD_AUDIO);

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            permissions.add(Manifest.permission.POST_NOTIFICATIONS);
        }

        List<String> needed = new ArrayList<>();
        for (String perm : permissions) {
            if (ContextCompat.checkSelfPermission(this, perm) != PackageManager.PERMISSION_GRANTED) {
                needed.add(perm);
            }
        }

        if (!needed.isEmpty()) {
            ActivityCompat.requestPermissions(this, needed.toArray(new String[0]), PERMISSION_REQUEST_CODE);
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, @NonNull String[] permissions, @NonNull int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
    }

    @Override
    public void onBackPressed() {
        if (webView.canGoBack()) {
            webView.goBack();
        } else {
            super.onBackPressed();
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        webView.onResume();
    }

    @Override
    protected void onPause() {
        // Do NOT call webView.onPause() — it suspends WebRTC
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        stopKeepAlive();
        super.onDestroy();
    }

    public class SetupBridge {
        @android.webkit.JavascriptInterface
        public void connect(String url) {
            getPrefs().edit().putString(KEY_URL, url).apply();
            runOnUiThread(() -> {
                webView.loadUrl(url);
                startKeepAlive();
            });
        }

        @android.webkit.JavascriptInterface
        public String getSavedUrl() {
            return getPrefs().getString(KEY_URL, "");
        }
    }
}
