# Updates: architecture and operations

This document is the reference for how Osmograph checks for, verifies, and
installs updates. It is written for both users and maintainers: the first half
is the behaviour you can observe, the second half is how to ship it.

## What users get

- **Automatic checks by default.** On launch, then at most once per 24 hours
  while the app stays open. Manual and Never remain available.
- **Stable / Beta channels.** A prerelease build starts on Beta; a plain
  `x.y.z` build starts on Stable. Either can be changed in Settings → Updates.
- **Release notes in the panel.** The release name, date, version, "What's
  new", "Bug fixes", and every installer on the release are shown before
  anything is downloaded.
- **In-place install when the release supports it.** The update is downloaded
  from GitHub, checked against the public key compiled into the app, installed,
  and the app restarts. If the release has no signed manifest, or the copy is a
  development/portable build, the button is not offered and the normal browser
  download remains.
- **Honest failure states.** Offline, rate-limited, no-release, already-newer,
  unsigned, wrong-platform, and cancelled-password states each say what
  happened. A failed check never erases the last release you were shown.

Once the user presses **Install update**, the download and install run without
an installer wizard. The app does not start an install on its own. On Windows
the installer runs quietly (`/S`); on Linux a `.deb`/`.rpm` install may ask for
the system password; an AppImage replaces itself without one.

## Layers

```
Settings → Updates
      │  check (metadata only)
      ▼
src/main.ts ──invoke──> src-tauri/src/updates.rs
                              │  HTTPS, ETag, 24 h gate
                              ▼
                    GitHub Releases API (30 releases)
                              │  release body + asset URLs
                              ▼
                    UpdateCheck payload
                    (notes, assets, latest.json URL)
                              │  user presses Install update
                              ▼
                    updates::install_update
                              │  validates the manifest URL belongs to
                              │  OpenSmell/osmograph-desktop
                              ▼
                    Tauri updater plugin
                      ├─ fetch latest.json (release asset)
                      ├─ fetch the platform bundle (.AppImage/.deb/.rpm,
                      │  NSIS .exe, .msi, or macOS .app.tar.gz)
                      ├─ verify the minisign .sig against the embedded pubkey
                      └─ install, then restart
```

### Frontend (`src/main.ts`, `index.html`)

- Persists `osmograph.updatePolicy` (`auto` / `manual` / `never`) and
  `osmograph.updateChannel` (`stable` / `beta`).
- Renders release notes and assets; groups auto-generated GitHub notes into
  "What's new" and "Bug fixes".
- Calls `update_install_support` once at startup, so it knows whether this
  package can replace itself. Development builds, portable binaries, and a copy
  running from a DMG report `supported: false` with a reason.
- Calls `install_update` only with the `updater_url` returned by the Rust check.
- Listens for `update-progress` events and renders a neutral progress bar.
- Refuses to start an install while a phase recording is active, so a
  recording cannot be interrupted by a restart.
- Calls `restart_app` after a successful install; on Windows the updater exits
  the process itself.

### Metadata check (`src-tauri/src/updates.rs`)

- Reads `https://api.github.com/repos/OpenSmell/osmograph-desktop/releases?per_page=30`.
  The list endpoint is deliberate: `/releases/latest` excludes prereleases, so
  a beta-only release would be invisible.
- One conditional request per channel with `If-None-Match`; a repeat check is a
  ~300-byte `304`.
- `AUTO_INTERVAL_SECS = 86400`, `FAILED_RETRY_SECS = 900`.
- Cache: `Osmograph/updates.json` under the platform config directory
  (`~/.config` on Linux, `~/Library/Application Support` on macOS,
  `%APPDATA%` on Windows). Delete it to force a full refetch.
- Selects the newest release the channel allows, then ranks installers for the
  current OS/architecture. A known architecture mismatch is never recommended.
- `latest.json` is classified as a manifest, not a download. Its presence is
  exposed as `latest.updater_url`; it is never shown in "All downloads".
- Everything here is metadata. No installer is fetched until the user chooses
  to install or download.

### Install path (`updates::install_update`)

- Accepts only an `https://github.com/OpenSmell/osmograph-desktop/releases/download/.../latest.json`
  URL with no credentials, query, or fragment. A compromised renderer cannot
  point the updater at another server.
- Re-checks `update_install_support`; a dev/portable copy refuses with a reason.
- Builds a Tauri updater with that manifest as its only endpoint and a 30-second
  timeout.
- The updater plugin chooses `{os}-{arch}-{bundle}` from the manifest, falling
  back to `{os}-{arch}`. The release manifest includes both typed keys where
  relevant:
  - `linux-x86_64-appimage`, `linux-x86_64-deb`, `linux-x86_64-rpm`
  - `windows-x86_64-nsis`, `windows-x86_64-msi`
  - `darwin-aarch64-app` / `darwin-x86_64-app`
- It downloads the bundle and verifies the minisign signature **before**
  touching the installed app. A bad signature leaves the current install
  untouched and the UI says so.
- Progress events: `downloading` (with bytes), `installing`, `installed`.
- `restart_app` restarts into the new binary on Linux/macOS. On Windows the
  updater launches the NSIS/MSI installer and exits.

## Platform matrix

| Installed from | In-place update | What happens |
| --- | --- | --- |
| Linux AppImage | Yes | The AppImage file is replaced in place; no password. |
| Linux `.deb` | Yes | `pkexec`/GUI sudo/`sudo` runs `dpkg -i`; may ask for the password. |
| Linux `.rpm` | Yes | Same path with `rpm -U`. |
| Windows NSIS (`.exe`) | Yes | Quiet install (`/S`); the installer restarts Osmograph. |
| Windows MSI | Yes | Quiet `msiexec` path. |
| macOS `.app` in Applications | Yes | The `.app` is replaced from `*.app.tar.gz`; restart. |
| macOS running from a DMG | No | Move Osmograph to Applications first. |
| Dev build / portable binary | No | Download the installer from the release page. |
| Old build without the updater key | No | Download the first updater-capable release manually once. |

macOS also needs a Developer ID signature and notarization for a smooth
Gatekeeper experience. The updater's minisign check is a separate, additional
guarantee; it does not replace Apple notarization.

The current CI builds Linux and Windows on x86_64 and macOS on the runner's
architecture (`macos-latest` is arm64). A macOS user on the other architecture
gets the browser download rather than an in-place update. Add a second macOS
runner or a universal build if both Mac architectures must update in place.

## Release manifest (`latest.json`)

Each tagged release publishes a `latest.json` asset. It is generated by
`scripts/make-latest-json.mjs` after every platform artifact is collected:

```json
{
  "version": "0.1.2-beta.2",
  "pub_date": "2026-11-04T09:22:00.000Z",
  "platforms": {
    "linux-x86_64-appimage": {
      "signature": "<contents of Osmograph-linux-x86_64.AppImage.sig>",
      "url": "https://github.com/OpenSmell/osmograph-desktop/releases/download/v0.1.2-beta.2/Osmograph-linux-x86_64.AppImage"
    },
    "linux-x86_64-deb": { "signature": "…", "url": "…" },
    "linux-x86_64-rpm": { "signature": "…", "url": "…" },
    "windows-x86_64-nsis": { "signature": "…", "url": "…" },
    "windows-x86_64-msi": { "signature": "…", "url": "…" },
    "darwin-aarch64-app": { "signature": "…", "url": "…app.tar.gz" }
  }
}
```

- `signature` is the **contents** of the `.sig` file, not a URL.
- The generator refuses to write a manifest if a recognized artifact has no
  `.sig`; an unsigned release cannot silently advertise an update.
- `.dmg`, `SHA256SUMS.txt`, `latest.json`, and `.sig` files are not updater
  payloads.
- The app fetches this file from the specific release tag, not from
  `releases/latest`, so beta and stable can coexist. The fallback endpoint in
  `tauri.conf.json` is only a safety net for other callers; the install command
  always passes the selected release's manifest URL.

## One-time signing setup

The public key is embedded in the app. The private key stays on the
maintainer's machine and in GitHub Actions secrets.

```bash
cd osmograph-desktop
npm run setup:updater-keys
```

This:

1. Generates a minisign keypair under `~/.config/osmograph/` (mode 600).
2. Writes the public half into `src-tauri/tauri.conf.json` under
   `plugins.updater.pubkey`.
3. Prints the private-key and password file paths.

Add both as **repository secrets** (Settings → Secrets and variables → Actions):

| Secret | Value |
| --- | --- |
| `TAURI_SIGNING_PRIVATE_KEY` | Contents of `~/.config/osmograph/updater.key` |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Contents of `~/.config/osmograph/updater.key.password` |

Back both up. Installed builds embed only the public key. If you lose the
private key or password, those builds cannot verify your next update.

`--force` rotates the key, but **do not rotate casually**: an installed build
trusts the key it was built with. To rotate, ship a bridge release signed with
the old key that contains the new public key, then switch. Until then, users
must download manually.

### Why local builds do not sign

`tauri.conf.json` keeps `createUpdaterArtifacts` off so a normal
`npm run tauri -- build` does not require the private key. CI passes
`--config src-tauri/tauri.updater.conf.json`, which enables it and produces the
`.sig` files. Only tagged releases are updatable sources.

## Cutting a release

1. Set the version everywhere:

   ```bash
   npm run set-version -- 0.1.2-beta.2
   npm run check:versions -- v0.1.2-beta.2
   ```

2. Add notes to `CHANGELOG.md`. GitHub release notes can be left to
   `generate_release_notes`; the app groups `## What's Changed` into what's new
   and bug fixes.
3. Verify locally:

   ```bash
   npx tsc --noEmit
   npm run build
   npm run test:latest-json
   (cd src-tauri && cargo test)
   ```

4. Commit, tag, push:

   ```bash
   git add -A
   git commit -m "Release v0.1.2-beta.2"
   git tag v0.1.2-beta.2
   git push origin master --tags
   ```

5. CI:

   - Refuses a tag that disagrees with the version files.
   - Fails a tagged build if `TAURI_SIGNING_PRIVATE_KEY` is missing.
   - Builds Linux `.deb`/`.rpm` and attempts an AppImage (best effort; a failed
     AppImage does not block the release, but AppImage users then get the
     browser download).
   - Builds Windows NSIS/MSI and macOS `.dmg` + `.app.tar.gz`.
   - Copies each friendly alias **with** its `.sig`.
   - Generates `latest.json` in the publish job; the release fails if no signed
     platform artifacts exist.
   - Publishes a prerelease for a tag containing `-`, and GitHub's latest for a
     plain tag.

6. Install the release and press **Check now**. The panel should show the
   notes and an **Install update** button. Press it; the app should download,
   verify, install, and restart into the new version.

## Verifying end to end

Useful checks, in order:

```bash
# 1. The manifest generator itself
npm run test:latest-json

# 2. The UI contract (requires a Vite dev server)
npm run dev -- --port 5173
npm run test:updates-ui

# 3. Rust logic and notes grouping
(cd src-tauri && cargo test)

# 4. Version consistency for a tag
npm run check:versions -- v0.1.2-beta.2
```

For a real end-to-end test:

1. Install the previous release (e.g. `v0.1.2-beta.2`) from the release page.
2. Tag and publish a newer prerelease.
3. In the installed app: Settings → Updates → **Check now**.
4. Confirm the release name, what's new, and bug fixes.
5. Press **Install update**; confirm it downloads, verifies, installs, and
   restarts into the new version.
6. Check the version in the footer and About.

A test with no signature is not a passing test. If the app falls back to a
browser download, inspect the release assets for `latest.json` and the `.sig`
files before assuming the updater works.

## Failure modes and what the user sees

| Situation | Behaviour |
| --- | --- |
| Offline / DNS failure | "Couldn't check: …"; the last cached release stays visible. |
| GitHub rate limit | Message includes the reset time. Metadata checks are the only API calls. |
| No release on the channel | Honest "No stable release…" / "No releases…" notice. |
| Build is newer than the release | "This build is newer than the latest…" notice. |
| Release has no `latest.json` | Download-only; no in-place button. |
| Dev / portable / DMG copy | In-place button hidden; reason shown. |
| Unsupported platform key | "This release has no installer for…"; browser download remains. |
| Bad signature | "failed signature verification. Nothing was installed." |
| Cancelled password prompt | "The install was cancelled…"; nothing installed. |
| Package manager failure | "The package manager could not install…"; browser download remains. |
| Install succeeded, restart failed | "Installed. Close and reopen Osmograph…" |

## Security model

- **Metadata** is public. The check sends no token, no machine id, and no
  recording. It only reads GitHub's public release listing.
- **Artifact integrity** comes from the minisign signature verified against the
  public key compiled into the app. The manifest is fetched over HTTPS from the
  pinned GitHub repository, and the app validates that URL before using it.
- **Manifest freshness**: `requireSignedVersion` is not enabled in this beta.
  The signature covers the artifact, but not the version string in the
  manifest. Keep the private key and GitHub account secure; enabling signed
  versions is a future hardening step once every artifact is known to carry
  them.
- **No self-install without consent.** Downloads start only from the explicit
  Install button. There is no background installer.
- **No rehosting.** The app downloads from the original GitHub release assets.

## Files

| File | Purpose |
| --- | --- |
| `src-tauri/src/updates.rs` | Metadata check, channel/policy logic, notes, asset ranking, install support, signed install. |
| `src/main.ts` | Update panel, progress UI, policy/channel persistence, restart. |
| `index.html` | Updates/About markup and update styles. |
| `src-tauri/tauri.conf.json` | Embedded updater public key, fallback endpoint, Windows install mode. |
| `src-tauri/tauri.updater.conf.json` | CI override that enables signed updater artifacts. |
| `scripts/setup-updater-keys.mjs` | One-time key generation and public-key patching. |
| `scripts/make-latest-json.mjs` | Builds the signed update manifest from release assets. |
| `scripts/test-latest-json.mjs` | Contract tests for the manifest generator. |
| `.github/workflows/release.yml` | Signed builds, AppImage best effort, manifest generation, release. |
| `RELEASING.md` | The short release checklist. |
