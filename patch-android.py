#!/usr/bin/env python3
"""
Applies MoneyTrack's native code and manifest/theme changes to the Android project that
`npx cap add android` generated. Idempotent (safe to run twice) and strict: it fails the
build loudly if an expected anchor is missing instead of silently producing a broken APK.
"""
import json
import re
import shutil
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ANDROID = ROOT / "android"
NATIVE_JAVA = ROOT / "android-native" / "app" / "src" / "main" / "java"

APP_ID = json.loads((ROOT / "capacitor.config.json").read_text(encoding="utf-8"))["appId"]
PKG_PATH = Path(*APP_ID.split("."))
MAIN = ANDROID / "app" / "src" / "main"


def fail(msg):
    print(f"ERROR: {msg}", file=sys.stderr)
    sys.exit(1)


if not MAIN.is_dir():
    fail(f"{MAIN} not found - run `npx cap add android` first")

# ---------------------------------------------------------------- 1. Java sources
dest = MAIN / "java" / PKG_PATH
dest.mkdir(parents=True, exist_ok=True)
sources = sorted((NATIVE_JAVA / PKG_PATH).glob("*.java"))
if not sources:
    fail(f"no Java sources in {NATIVE_JAVA / PKG_PATH}")
for src in sources:
    shutil.copy2(src, dest / src.name)
    print(f"copied {src.name}")
# MainActivity must exist exactly once (ours replaces the generated one).
mains = list((MAIN / "java").rglob("MainActivity.java"))
if len(mains) != 1 or mains[0].parent != dest:
    fail(f"expected exactly one MainActivity in {dest}, found: {[str(m) for m in mains]}")

# ---------------------------------------------------------------- 2. AndroidManifest.xml
manifest_path = MAIN / "AndroidManifest.xml"
manifest = manifest_path.read_text(encoding="utf-8")

PERMISSIONS = [
    "android.permission.READ_SMS",
    "android.permission.RECEIVE_SMS",
]
for perm in PERMISSIONS:
    if perm not in manifest:
        if "<application" not in manifest:
            fail("<application> not found in AndroidManifest.xml")
        manifest = manifest.replace(
            "<application",
            f'<uses-permission android:name="{perm}" />\n    <application', 1)

COMPONENTS = f"""
        <service
            android:name="{APP_ID}.MoneyTrackNotificationListener"
            android:label="MoneyTrack transaction alerts"
            android:exported="true"
            android:permission="android.permission.BIND_NOTIFICATION_LISTENER_SERVICE">
            <intent-filter>
                <action android:name="android.service.notification.NotificationListenerService" />
            </intent-filter>
        </service>

        <receiver
            android:name="{APP_ID}.MoneyTrackSmsReceiver"
            android:exported="true"
            android:permission="android.permission.BROADCAST_SMS">
            <intent-filter android:priority="999">
                <action android:name="android.provider.Telephony.SMS_RECEIVED" />
            </intent-filter>
        </receiver>
"""
if "MoneyTrackNotificationListener" not in manifest:
    if "</application>" not in manifest:
        fail("</application> not found in AndroidManifest.xml")
    manifest = manifest.replace("</application>", COMPONENTS + "    </application>", 1)

# Financial data + message text: do not let Android auto-backup copy it to the cloud.
manifest = manifest.replace('android:allowBackup="true"', 'android:allowBackup="false"')

manifest_path.write_text(manifest, encoding="utf-8")
try:
    ET.fromstring(manifest)
except ET.ParseError as e:
    fail(f"AndroidManifest.xml is not well-formed after patching: {e}")
for needle in PERMISSIONS + ["MoneyTrackNotificationListener", "MoneyTrackSmsReceiver"]:
    if needle not in manifest:
        fail(f"manifest is missing {needle}")
print("patched AndroidManifest.xml")

# ---------------------------------------------------------------- 3. dark-only theme
res = MAIN / "res"
(res / "values").mkdir(parents=True, exist_ok=True)
(res / "values" / "moneytrack_colors.xml").write_text(
    '<?xml version="1.0" encoding="utf-8"?>\n<resources>\n'
    '    <color name="moneytrack_bg">#090D18</color>\n</resources>\n', encoding="utf-8")

styles_path = res / "values" / "styles.xml"
if not styles_path.exists():
    fail("res/values/styles.xml not found")
styles = styles_path.read_text(encoding="utf-8")
# Dark only: replace day/night parents with the always-dark-capable AppCompat base.
styles = re.sub(r"Theme\.AppCompat\.DayNight\.[A-Za-z]+", "Theme.AppCompat.NoActionBar", styles)
styles = re.sub(r"Theme\.AppCompat\.DayNight\b", "Theme.AppCompat", styles)
if "DayNight" in styles:
    fail("a DayNight theme is still present in styles.xml")
EXTRA = (
    '        <item name="android:windowBackground">@color/moneytrack_bg</item>\n'
    '        <item name="android:statusBarColor">@color/moneytrack_bg</item>\n'
    '        <item name="android:navigationBarColor">@color/moneytrack_bg</item>\n'
    '        <item name="android:windowOptOutEdgeToEdgeEnforcement">true</item>\n'
)
def add_items(match):
    block = match.group(0)
    if "moneytrack_bg" in block:
        return block
    # For the launch theme the splash background item must also be dark.
    block = re.sub(r'(<item name="android:background">)[^<]*(</item>)',
                   r'\1@color/moneytrack_bg\2', block)
    return block.replace(">\n", ">\n" + EXTRA, 1) if ">\n" in block else block
styles, n = re.subn(r'<style name="AppTheme[^"]*"[^>]*>.*?</style>', add_items, styles, flags=re.S)
if n == 0:
    fail("no AppTheme styles found in styles.xml")
styles_path.write_text(styles, encoding="utf-8")
ET.fromstring(styles)
print(f"patched styles.xml ({n} style blocks)")

print("Android project patched OK for", APP_ID)
