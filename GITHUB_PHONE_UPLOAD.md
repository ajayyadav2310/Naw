# Upload MoneyTrack to GitHub from an Android phone, build the APK, install it

GitHub's mobile web upload cannot keep folders or hidden folders (`.github`), so the reliable phone method is **Termux** (a terminal app). It takes about 10 minutes.

## A. One-time setup

1. Create a free account at <https://github.com> (Chrome → "Desktop site" is not needed).
2. Create an empty repository: **+ → New repository** → name `MoneyTrack` → **Private** is fine → *do not* add README/.gitignore → **Create repository**.
3. Create an access token: GitHub → profile photo → **Settings → Developer settings → Personal access tokens → Tokens (classic) → Generate new token (classic)**.
   Tick **repo** and **workflow**, set an expiry, **Generate**, and copy the token (you will paste it as the "password").
4. Install **Termux from F-Droid** (<https://f-droid.org/packages/com.termux/>). The Play Store version is outdated.
5. Save `MoneyTrack-Final.zip` into your phone's **Downloads** folder.

## B. Upload (in Termux)

```bash
pkg update -y && pkg install -y git unzip
termux-setup-storage                      # tap "Allow"
cd ~ && unzip ~/storage/downloads/MoneyTrack-Final.zip
cd MoneyTrack
git init -b main
git config user.name  "Your Name"
git config user.email "you@example.com"
git add -A
git commit -m "MoneyTrack"
git remote add origin https://github.com/YOUR_GITHUB_USERNAME/MoneyTrack.git
git push -u origin main
```

When asked, **Username** = your GitHub username, **Password** = the token from step 3.
Check on GitHub that the file list includes `.github/workflows/android-debug.yml`.

## C. Build the APK

The push to `main` starts the build automatically. To start it manually:
GitHub repo → **Actions** → **Build MoneyTrack Android debug APK** → **Run workflow** → **Run workflow**.
The first build takes roughly 6–12 minutes. A green tick means: tests passed, APK built, and the APK was checked to contain the SMS permissions, the notification service and the SMS receiver.
If it turns red, open the run, tap the red step and send me the error text.

## D. Download

Either:
- **Releases** (right side of the repo page) → **MoneyTrack debug APK (latest build)** → tap **MoneyTrack-debug.apk** (plain APK), or
- **Actions** → the run → **Artifacts** → **MoneyTrack-debug-apk** (a ZIP; extract it with the Files app).

## E. Install

1. Open the downloaded APK. If asked, allow **Install unknown apps** for your browser/Files app.
2. If Play Protect warns about an unrecognised app, choose **Install anyway** (it is your own debug build).
3. Open MoneyTrack → ⚙ **Settings → Automatic tracking** and follow the three numbered buttons
   (see "First run on the phone" in `README.md`, including **Allow restricted settings** on Android 13+).

## Updating later

Edit files on GitHub (pencil icon) or repeat `git add -A && git commit -m "change" && git push` in Termux; every push to `main` builds a new APK.

**Important:** every CI run signs the debug APK with a freshly generated debug key, so Android will not install a new build *over* an old one ("App not installed").
To update you must uninstall the old app first, which **deletes its data**. So before updating: **Settings → Export backup (JSON)**, install the new APK, then **Settings → Restore backup**.
