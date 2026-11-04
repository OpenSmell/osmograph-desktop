#!/usr/bin/env node
// Contract tests for the updater-manifest generator. No network, no builds.
//
//   npm run test:latest-json

import assert from 'node:assert/strict';
import { buildManifest, platformKeyFor } from './make-latest-json.mjs';

const results = [];
function check(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
    console.log(`PASS ${name}`);
  } catch (error) {
    results.push({ name, ok: false, error });
    console.log(`FAIL ${name} — ${error.message}`);
  }
}

check('Linux AppImage maps to a typed target', () => {
  assert.equal(
    platformKeyFor('Osmograph-linux-x86_64.AppImage'),
    'linux-x86_64-appimage',
  );
});

check('Debian amd64 is normalised to x86_64', () => {
  assert.equal(platformKeyFor('Osmograph-linux-amd64.deb'), 'linux-x86_64-deb');
});

check('RPM and macOS archives keep their type', () => {
  assert.equal(platformKeyFor('Osmograph-linux-x86_64.rpm'), 'linux-x86_64-rpm');
  assert.equal(
    platformKeyFor('Osmograph-macos-aarch64.app.tar.gz'),
    'darwin-aarch64-app',
  );
});

check('Windows installers default to the x64 target', () => {
  assert.equal(platformKeyFor('Osmograph-setup.exe'), 'windows-x86_64-nsis');
  assert.equal(platformKeyFor('Osmograph.msi'), 'windows-x86_64-msi');
});

check('dmg, sums, manifest and signatures are not updater payloads', () => {
  for (const name of [
    'Osmograph-macos-aarch64.dmg',
    'SHA256SUMS.txt',
    'latest.json',
    'Osmograph-linux-x86_64.AppImage.sig',
  ]) {
    assert.equal(platformKeyFor(name), null, name);
  }
});

const signed = (name, contents = `sig:${name}`) => ({ name, contents });
const assets = [
  signed('Osmograph-linux-x86_64.AppImage.sig'),
  signed('Osmograph-linux-amd64.deb.sig'),
  signed('Osmograph-linux-x86_64.rpm.sig'),
  signed('Osmograph-setup.exe.sig'),
  signed('Osmograph.msi.sig'),
  signed('Osmograph-macos-aarch64.app.tar.gz.sig'),
  { name: 'Osmograph-linux-x86_64.AppImage', contents: '' },
  { name: 'Osmograph-linux-amd64.deb', contents: '' },
  { name: 'Osmograph-linux-x86_64.rpm', contents: '' },
  { name: 'Osmograph-setup.exe', contents: '' },
  { name: 'Osmograph.msi', contents: '' },
  { name: 'Osmograph-macos-aarch64.app.tar.gz', contents: '' },
  { name: 'Osmograph-macos-aarch64.dmg', contents: '' },
  { name: 'SHA256SUMS.txt', contents: '' },
];

check('manifest includes every signed platform once', () => {
  const manifest = buildManifest({
    assets,
    tag: 'v0.1.2-beta.2',
    repo: 'OpenSmell/osmograph-desktop',
    now: new Date('2026-03-01T10:00:00Z'),
  });
  assert.equal(manifest.version, '0.1.2-beta.2');
  assert.equal(manifest.pub_date, '2026-03-01T10:00:00.000Z');
  assert.deepEqual(Object.keys(manifest.platforms), [
    'darwin-aarch64-app',
    'linux-x86_64-appimage',
    'linux-x86_64-deb',
    'linux-x86_64-rpm',
    'windows-x86_64-msi',
    'windows-x86_64-nsis',
  ]);
  const appimage = manifest.platforms['linux-x86_64-appimage'];
  assert.equal(appimage.signature, 'sig:Osmograph-linux-x86_64.AppImage.sig');
  assert.equal(
    appimage.url,
    'https://github.com/OpenSmell/osmograph-desktop/releases/download/v0.1.2-beta.2/Osmograph-linux-x86_64.AppImage',
  );
});

check('an unsigned artifact fails the release', () => {
  assert.throws(
    () =>
      buildManifest({
        assets: [{ name: 'Osmograph-linux-x86_64.AppImage', contents: '' }],
        tag: 'v0.1.2',
        repo: 'OpenSmell/osmograph-desktop',
      }),
    /unsigned/,
  );
});

check('an empty signature fails the release', () => {
  assert.throws(
    () =>
      buildManifest({
        assets: [
          { name: 'Osmograph-linux-x86_64.AppImage', contents: '' },
          { name: 'Osmograph-linux-x86_64.AppImage.sig', contents: '   ' },
        ],
        tag: 'v0.1.2',
        repo: 'OpenSmell/osmograph-desktop',
      }),
    /unsigned/,
  );
});

check('a signed artifact without a manifest fails instead of guessing', () => {
  assert.throws(
    () =>
      buildManifest({
        assets: [{ name: 'Osmograph-linux-x86_64.dmg', contents: '' }],
        tag: 'v0.1.2',
        repo: 'OpenSmell/osmograph-desktop',
      }),
    /no signed updater artifacts/,
  );
});

check('a malformed repository is rejected', () => {
  assert.throws(
    () =>
      buildManifest({
        assets,
        tag: 'v0.1.2',
        repo: 'not-a-repo',
      }),
    /owner\/name/,
  );
});

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} assertions passed.`);
process.exit(failed ? 1 : 0);
