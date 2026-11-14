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
console.log('patched: versionName', versionName, 'versionCode', versionCode);
