# Osmograph Changelog

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
