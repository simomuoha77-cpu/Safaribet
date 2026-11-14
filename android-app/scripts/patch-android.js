// Applies SafariBet-specific settings to the generated Capacitor Android project. Tolerant: warns instead of failing.
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..', 'android', 'app');
const versionName = process.env.VERSION_NAME || '1.0.0';
const versionCode = parseInt(process.env.VERSION_CODE || '1', 10);
function edit(file, fn) {
  const p = path.join(root, file);
  if (!fs.existsSync(p)) return console.warn('skip (missing):', file);
  const before = fs.readFileSync(p, 'utf8'), after = fn(before);
  if (after === before) console.warn('no change:', file); else fs.writeFileSync(p, after);
}
edit('build.gradle', s => s
  .replace(/versionCode\s+\d+/, 'versionCode ' + versionCode)
  .replace(/versionName\s+"[^"]*"/, 'versionName "' + versionName + '"'));
edit('src/main/AndroidManifest.xml', s => {
  if (!/android:allowBackup=/.test(s)) s = s.replace('<application', '<application android:allowBackup="false"');
  else s = s.replace(/android:allowBackup="[^"]*"/, 'android:allowBackup="false"');
  if (!/screenOrientation/.test(s)) s = s.replace('<activity', '<activity android:screenOrientation="portrait"');
  return s;
});
edit('src/main/res/values/styles.xml', s => s.includes('statusBarColor') ? s :
  s.replace(/(<style name="AppTheme\.NoActionBar"[^>]*>)/, '$1\n        <item name="android:statusBarColor">#0a0e0a</item>\n        <item name="android:navigationBarColor">#0a0e0a</item>'));

// ── Pull-to-refresh: wrap the WebView in a SwipeRefreshLayout ──
edit('build.gradle', s => s.includes('swiperefreshlayout') ? s :
  s.replace(/dependencies\s*\{/, 'dependencies {\n    implementation "androidx.swiperefreshlayout:swiperefreshlayout:1.1.0"'));
const javaDir = path.join(root, 'src', 'main', 'java', 'top', 'safaribet', 'app');
fs.mkdirSync(javaDir, { recursive: true });
fs.writeFileSync(path.join(javaDir, 'MainActivity.java'), `package top.safaribet.app;

import android.Manifest;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.graphics.drawable.GradientDrawable;
import android.os.Handler;
import android.os.Looper;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.WebView;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import androidx.swiperefreshlayout.widget.SwipeRefreshLayout;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    private static final String HOME = "https://safaribet.top";

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        showSplashOverlay();
    }

    // Launch screen: the SafariBet icon, a row of sport icons and moving dots, shown until the site has loaded.
    private void showSplashOverlay() {
        final float d = getResources().getDisplayMetrics().density;
        final int GREEN = 0xFF00C853, DIM = 0x44FFFFFF;
        final FrameLayout overlay = new FrameLayout(this);
        overlay.setBackgroundColor(0xFF0A0E0A);
        overlay.setClickable(true);

        ImageView tile = new ImageView(this);
        int tileRes = getResources().getIdentifier("splash_tile", "drawable", getPackageName());
        if (tileRes != 0) tile.setImageResource(tileRes);
        overlay.addView(tile, new FrameLayout.LayoutParams((int) (150 * d), (int) (150 * d), Gravity.CENTER));

        LinearLayout bottom = new LinearLayout(this);
        bottom.setOrientation(LinearLayout.VERTICAL);
        bottom.setGravity(Gravity.CENTER_HORIZONTAL);

        LinearLayout icons = new LinearLayout(this);
        icons.setOrientation(LinearLayout.HORIZONTAL);
        icons.setGravity(Gravity.CENTER);
        int[] sports = {0x26BD, 0x1F3C0, 0x1F3BE, 0x1F3D0, 0x1F3C6};
        for (int cp : sports) {
            TextView t = new TextView(this);
            t.setText(new String(Character.toChars(cp)));
            t.setTextSize(TypedValue.COMPLEX_UNIT_SP, 28);
            t.setPadding((int) (9 * d), 0, (int) (9 * d), 0);
            icons.addView(t);
        }
        bottom.addView(icons);

        LinearLayout dotsRow = new LinearLayout(this);
        dotsRow.setOrientation(LinearLayout.HORIZONTAL);
        dotsRow.setGravity(Gravity.CENTER);
        final View[] dots = new View[5];
        for (int i = 0; i < dots.length; i++) {
            View dot = new View(this);
            GradientDrawable g = new GradientDrawable();
            g.setShape(GradientDrawable.OVAL);
            g.setColor(i == 0 ? GREEN : DIM);
            dot.setBackground(g);
            LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams((int) (8 * d), (int) (8 * d));
            lp.setMargins((int) (6 * d), (int) (18 * d), (int) (6 * d), 0);
            dotsRow.addView(dot, lp);
            dots[i] = dot;
        }
        bottom.addView(dotsRow);

        FrameLayout.LayoutParams blp = new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM);
        blp.bottomMargin = (int) (72 * d);
        overlay.addView(bottom, blp);

        addContentView(overlay, new ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        final Handler h = new Handler(Looper.getMainLooper());
        final long start = System.currentTimeMillis();
        final int[] step = {0};
        h.postDelayed(new Runnable() {
            @Override
            public void run() {
                step[0]++;
                for (int i = 0; i < dots.length; i++) {
                    ((GradientDrawable) dots[i].getBackground()).setColor(i == step[0] % dots.length ? GREEN : DIM);
                }
                long elapsed = System.currentTimeMillis() - start;
                WebView w = getBridge() != null ? getBridge().getWebView() : null;
                String u = w != null ? w.getUrl() : null;
                boolean loaded = w != null && u != null && u.startsWith("http") && w.getProgress() >= 100;
                if ((loaded && elapsed >= 2600) || elapsed >= 10000) {
                    overlay.animate().alpha(0f).setDuration(300).withEndAction(new Runnable() {
                        @Override
                        public void run() {
                            ViewGroup p = (ViewGroup) overlay.getParent();
                            if (p != null) p.removeView(overlay);
                        }
                    }).start();
                    return;
                }
                h.postDelayed(this, 350);
            }
        }, 350);
    }

    @Override
    public void onStart() {
        super.onStart();
        setupPullToRefresh();
        askNotificationPermission();
        openLink(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        openLink(intent);
    }

    // A safaribet.top link tapped anywhere (WhatsApp, SMS, browser...) opens inside the app, on that exact page.
    private void openLink(Intent intent) {
        if (intent == null) return;
        Uri data = intent.getData();
        if (data == null) return;
        String url = data.toString();
        intent.setData(null);
        if (!url.startsWith(HOME)) return;
        WebView webView = getBridge().getWebView();
        if (webView != null) webView.loadUrl(url);
    }

    // Android 13+ needs the user to allow notifications.
    private void askNotificationPermission() {
        if (Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            ActivityCompat.requestPermissions(this, new String[]{Manifest.permission.POST_NOTIFICATIONS}, 1001);
        }
    }

    private void setupPullToRefresh() {
        final WebView webView = getBridge().getWebView();
        if (webView == null || webView.getParent() instanceof SwipeRefreshLayout) return;
        ViewGroup parent = (ViewGroup) webView.getParent();
        int index = parent.indexOfChild(webView);
        ViewGroup.LayoutParams lp = webView.getLayoutParams();
        parent.removeView(webView);
        final SwipeRefreshLayout swipe = new SwipeRefreshLayout(this);
        swipe.addView(webView, new ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        parent.addView(swipe, index, lp != null ? lp : new ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        swipe.setColorSchemeColors(0xFF00C853);
        swipe.setProgressBackgroundColorSchemeColor(0xFF0A0E0A);
        swipe.setOnRefreshListener(new SwipeRefreshLayout.OnRefreshListener() {
            @Override
            public void onRefresh() {
                String url = webView.getUrl();
                if (url == null || !url.startsWith(HOME)) webView.loadUrl(HOME); else webView.reload();
                swipe.postDelayed(new Runnable() { @Override public void run() { swipe.setRefreshing(false); } }, 1200);
            }
        });
    }
}
`);
// Links to safaribet.top open in this app (Android App Links); permission for notifications.
edit('src/main/AndroidManifest.xml', s => {
  if (!s.includes('POST_NOTIFICATIONS')) s = s.replace('<application', '<uses-permission android:name="android.permission.POST_NOTIFICATIONS" />\n    <application');
  if (!s.includes('android:host="safaribet.top"')) s = s.replace('</activity>',
    '    <intent-filter android:autoVerify="true">\n' +
    '            <action android:name="android.intent.action.VIEW" />\n' +
    '            <category android:name="android.intent.category.DEFAULT" />\n' +
    '            <category android:name="android.intent.category.BROWSABLE" />\n' +
    '            <data android:scheme="https" android:host="safaribet.top" />\n' +
    '        </intent-filter>\n    </activity>');
  return s;
});
// Launch screen: plain dark background, the big logo comes from the splash image (no small icon in a circle)
edit('src/main/res/values/styles.xml', s => s.includes('windowSplashScreenBackground') ? s :
  s.replace(/(<style name="AppTheme\.NoActionBarLaunch"[^>]*>)/, '$1\n        <item name="windowSplashScreenBackground">#0a0e0a</item>\n        <item name="windowSplashScreenAnimatedIcon">@drawable/splash_logo</item>'));
console.log('pull-to-refresh added');

console.log('patched: versionName', versionName, 'versionCode', versionCode);
