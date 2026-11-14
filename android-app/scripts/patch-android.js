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

import android.os.Bundle;
import android.view.ViewGroup;
import android.webkit.WebView;
import androidx.swiperefreshlayout.widget.SwipeRefreshLayout;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    private static final String HOME = "https://safaribet.top";

    @Override
    public void onStart() {
        super.onStart();
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
console.log('pull-to-refresh added');

console.log('patched: versionName', versionName, 'versionCode', versionCode);
