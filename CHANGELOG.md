# Osmograph Changelog

## v0.1.2-beta.3 — Vial Home, transforms, and window fit
- Home Vial switching is order-independent. The Vials page now has a Home Vial picker and a
  per-card **Use as Home** action; the Home ribbon, Fleet dropdown, picker, and cards all use the
  same path. Plant Respiration and Fermentation Lab can each become Home in either install order.
- The Vials page leads with domain, licence, and source, and labels Home-capable, sandboxed, and
  Ungated Vials. Card metadata is legible without zooming.
- Plant Respiration and Fermentation Lab 0.6.1 distinguish a pending profile from a quiet window.
  Fermentation withholds its array phase until the batch has started, and validates the start date.
- The desktop window opens inside the monitor work area at the display's scale factor. The default
  is 1100×700, the minimum is 640×360, and the window is hidden until it has been sized, so a
  scaled Windows display no longer flashes or opens oversized.
- Transforms are self-explanatory: a three-step explainer, a worked example, per-step hints,
  **Preview result**, and **Save pipeline**. A transform pipeline binds one source recording,
  previews the derived result, and never overwrites the original.
- Removed the dark first-run wizard. Osmograph now lands on Home with an inline start card:
  replay a sample, download a public corpus, import a recording, or connect a rig.
- A fresh install no longer opens the empty Gallery. Explore defaults to Datasets until there is
  something in the library, and the Gallery's empty state now offers the same starting paths.

## v0.1.2-beta.2 — update delivery
- Updates check automatically by default: once on launch, then at most once a day while the app stays
  open. Manual and Never remain available, and the 15-minute failure back-off stops offline launches
  from hammering GitHub.
- Stable/Beta channels. Beta builds follow prereleases, stable builds ignore them, and either can be
  changed in Settings → Updates. This also fixes beta-only releases never appearing: the checker now
  reads the release list instead of `releases/latest`, which excludes prereleases.
- The Updates panel shows the release name, date, version, what's new, bug fixes, and the installer for
  this platform. Auto-generated GitHub notes are grouped into "What's new" and "Bug fixes".
- Skip this version / Remind me later, a NEW badge on the Updates tab, honest offline/rate-limit
  messages, and cached release details that survive a failed check.
- The version and its stage (Alpha/Beta/Release candidate/Release) are shown in the footer and About,
  derived from the tag. `npm run set-version -- <version>` keeps every version field in sync, and CI
  refuses a tag that disagrees with the binary.
- Signed in-place updates. When a release publishes `latest.json`, **Install update** downloads the
  platform bundle from GitHub, verifies its minisign signature against the public key compiled into the
  app, installs it, and restarts. A failed install leaves the installed app untouched and offers the
  browser download. Development/portable builds and releases without a signed manifest never show the
  button.
- Release CI now signs the updater artifacts it builds (`.sig`), publishes `latest.json`, and refuses
  tagged builds without the signing key. `npm run setup:updater-keys` creates the keypair and patches the public key;
  see `docs/UPDATES.md` for the architecture, platform matrix, and key operations.
- This is the first build that trusts the update key. Earlier builds (including beta.1) must download
  `0.1.2-beta.2` manually once; from this build onward, signed updates can install in place.

## v0.1.2-beta.1 — public beta
- First public beta for hands-on feedback; this is a pre-release, not the stable channel.
- Selecting a Vial in Fleet now opens its full Home workspace, with host-owned rig and data status.
- Fixes release builds failing to resolve the yanked `zip` 2.x dependency.

## v0.1.1
- Auto-update checker with configurable policy (stable channel default; opt-in prerelease)
- Release assets: stable versionless filenames (`Osmograph-setup.exe`, `Osmograph.msi`,
  `Osmograph-macos-aarch64.dmg`, `Osmograph-linux-amd64.deb`, `Osmograph-linux-x86_64.rpm`)
  alongside versioned bundles, plus `SHA256SUMS.txt`
- Release no longer uploads exploded macOS `.app` internals
- CI: Rust lib tests + frontend build run on every push/PR
- Added MIT `LICENSE`

## v0.1.0
- Initial public release (Sep 18): real-time MOX monitoring, adaptive learning,
  Hugging Face dataset import (`hf_download`), serial/BLE/MDNS discovery.
