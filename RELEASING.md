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
   (cd src-tauri && cargo test)
   ```

5. Commit, then tag and push the tag:

   ```bash
   git add -A
   git commit -m "Release v0.1.2-beta.2"
   git tag v0.1.2-beta.2
   git push origin master --tags
   ```

6. `.github/workflows/release.yml` builds Linux (deb + rpm), Windows (NSIS + MSI)
   and macOS (dmg). A tag containing `-` is published as a **prerelease**; a plain
   tag also becomes GitHub's `latest`. The workflow refuses to build if the tag
   does not match the version files.
7. After the workflow finishes, open **Settings → Updates** in an installed build
   and press **Check now**. Beta builds should see the new prerelease; stable
   builds see only plain releases.

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

The check downloads **no installer**. The panel lists the assets on the release and
marks the best fit for the current OS/architecture; choosing one opens the GitHub
download URL in the browser. `SHA256SUMS.txt` is published with every release but
is not offered as an installer.

In-place self-update is not implemented. Doing it properly requires a Tauri updater
public key in `tauri.conf.json`, the matching private key in CI, a `latest.json`
manifest per platform, and signed bundles. Until that exists, the app will not
claim to install updates itself.

## If updates do not appear

1. Check the tag: `v0.1.2-beta.2` (prerelease) is only visible on the Beta channel.
2. Check the version files: `npm run check:versions -- v0.1.2-beta.2`.
3. Confirm the release workflow published assets, not just a tag.
4. Delete the update cache and press **Check now**.
5. A 403 in the panel means GitHub's rate limit; the message includes the reset
   time. Wait, or use a different network.
