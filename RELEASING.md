# Releasing Osmograph

Osmograph ships from GitHub Releases. The app checks those releases itself; there is
no separate update server.

## Stages and channels

The stage is **derived from the version tag**, so the label can never drift from
the binary:

| Version | Stage shown | GitHub | App channel |
| --- | --- | --- | --- |
| `0.2.0-alpha.1` | Alpha | prerelease | Beta |
| `0.2.0-beta.3` | Beta | prerelease | Beta |
| `0.2.0-rc.1` | Release candidate | prerelease | Beta |
| `0.2.0` | Release | published | Stable |

- **Alpha** means expect breakage. Do not use it for users who are not prepared to
  lose or re-export data.
- **Beta** is the honest label for the current `0.x` public builds: features and
  file formats can still change, but the app should not lose data. Say so in the
  About panel (it does) and in release notes.
- **Stable** means formats and the update path are frozen for that series.

A build whose version contains a prerelease suffix starts on the **Beta** channel.
A plain `x.y.z` build starts on **Stable**. Either can be changed in
**Settings → Updates**.

## First-time signing setup

Silent in-place updates need a minisign keypair. The public half is compiled
into the app; the private half signs release artifacts in CI and never enters
the repository.

```bash
npm run setup:updater-keys
```

The script writes the keypair under `~/.config/osmograph/` (mode 600) and puts
the public key into `src-tauri/tauri.conf.json`. Add both repository secrets:

- `TAURI_SIGNING_PRIVATE_KEY` — contents of `~/.config/osmograph/updater.key`
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` — contents of
  `~/.config/osmograph/updater.key.password`

Back both up. If they are lost, installed builds will not accept future
updates. Do not rotate the key casually: a build trusts the key it was compiled
with. Ship a bridge release signed with the old key before switching.

The first updater-capable build must be downloaded manually once: the build it
replaces does not have the public key yet. After that, signed updates install in
place.

The full architecture, manifest schema, and failure matrix are in
[`docs/UPDATES.md`](docs/UPDATES.md).

## Cut a release

1. Pick the next version. Example: `0.1.2-beta.2`.
2. Set it everywhere (package, lockfiles, Cargo, Tauri):

   ```bash
   npm run set-version -- 0.1.2-beta.2
   npm run check:versions
   ```

3. Add the release notes to `CHANGELOG.md` and, if helpful, draft the GitHub
   release body (see the template below).
4. Verify locally:

   ```bash
   npx tsc --noEmit
   npm run build
   npm run test:latest-json
   (cd src-tauri && cargo test)
   ```

5. Commit, then tag and push the tag:

   ```bash
   git add -A
   git commit -m "Release v0.1.2-beta.2"
   git tag v0.1.2-beta.2
   git push origin master --tags
   ```

6. `.github/workflows/release.yml` builds Linux (deb + rpm, AppImage best
   effort), Windows (NSIS + MSI) and macOS (dmg + `.app.tar.gz`), signs the
   updater artifacts it builds, and publishes `latest.json`. A tag containing `-` is published as a
   **prerelease**; a plain tag also becomes GitHub's `latest`. The workflow
   refuses to build if the tag does not match the version files, or if a tagged
   build has no signing key.
7. After the workflow finishes, open **Settings → Updates** in an installed
   build and press **Check now**. Beta builds should see the new prerelease;
   stable builds see only plain releases. Press **Install update** to verify the
   full download → signature verification → install → restart path.

## Release notes users actually see

The app reads the GitHub release body and groups it:

- `## What's new` / `## Features` / `## Changes` → **What's new**
- `## Bug fixes` / `## Fixes` / `## Patch` → **Bug fixes**
- `## Breaking changes` → shown as written
- Auto-generated notes (`## What's Changed`) are split bullet-by-bullet into
  **What's new** and **Bug fixes**, based on the words in each PR title.
- `**Full Changelog**: …` is kept as a final link section.

Suggested body:

```markdown
## What's new
- Live plant workspace now compares against a same-time-of-day baseline.

## Bug fixes
- Parameters without a payload no longer get dropped by the Vial host.

## Notes
Beta build. Export any recording you care about before a major update.
```

`generate_release_notes: true` is left on in CI. If you supply your own body it is
used instead; both formats render. Notes are capped at 20,000 characters so a
runaway changelog cannot bloat the check payload.

## How checking works

- Default policy: **Automatic** — once on launch, then at most once per 24 hours
  while the app stays open (hourly timer, backend-gated).
- Failed checks retry no sooner than 15 minutes, so being offline does not hammer
  GitHub.
- Manual: only **Check now**. Never: no network at all.
- One conditional request per channel with ETag/`If-None-Match`, so a repeat check
  is a ~300-byte `304`. Unauthenticated GitHub allows 60 requests/hour/IP; the
  cadence keeps the app far below that.
- The list endpoint (`/releases?per_page=30`) is used deliberately. GitHub's
  `releases/latest` excludes prereleases, so a beta-only project would never see
  its own updates.
- Cache: `Osmograph/updates.json` under the platform config directory (Linux
  `~/.config`, macOS `~/Library/Application Support`, Windows `%APPDATA%`).
  Delete it to force a full refetch.
- **Skip this version** and **Remind me later** are per-device and version-specific.
  Skipping does not hide the release from the panel.

## Downloads and installation

The metadata check downloads **no installer**. The panel lists the assets on the
release and marks the best fit for the current OS/architecture. If the release
published a signed `latest.json`, the panel also offers **Install update**:

- The app fetches the manifest and the platform bundle from GitHub.
- The Tauri updater verifies the bundle's minisign signature against the public
  key compiled into the app **before** installing.
- Linux AppImages replace themselves without a password. `.deb`/`.rpm` installs
  use the system package manager and may ask for the password. Windows runs the
  NSIS/MSI installer quietly. macOS replaces the app in Applications.
- The app restarts into the new version. On Windows the installer does the
  restart.
- A release without `latest.json`, a development/portable build, or a copy
  running from a DMG gets the browser download only, with the reason shown.

`SHA256SUMS.txt` is published with every release but is not offered as an
installer. See [`docs/UPDATES.md`](docs/UPDATES.md) for the manifest schema,
trust model, and signing-key operations.

## If updates do not appear

1. Check the tag: `v0.1.2-beta.2` (prerelease) is only visible on the Beta channel.
2. Check the version files: `npm run check:versions -- v0.1.2-beta.2`.
3. Confirm the release workflow published assets, not just a tag.
4. Delete the update cache and press **Check now**.
5. A 403 in the panel means GitHub's rate limit; the message includes the reset
   time. Wait, or use a different network.
6. **No Install update button:** confirm the release has a `latest.json` asset
   and signed artifacts. The build must not be a dev, portable, or DMG copy.
7. **Signature verification failed:** the app's embedded public key and the CI
   signing key do not match. Rebuild from the same key; do not rotate keys
   without a bridge release.
8. **Linux password prompt:** expected for `.deb`/`.rpm`. An AppImage does not
   need one. A cancelled prompt leaves the install untouched.
9. **`latest.json` missing from the release:** the publish job refused to
   generate it because an artifact was unsigned or no updater artifacts were
   found. Check the signing secrets and the build logs.
