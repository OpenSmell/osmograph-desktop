#!/usr/bin/env node
// Keep every place the app version appears in sync, in one command:
//
//   npm run set-version -- 0.2.0-beta.1
//   npm run check:versions                     # verify all files agree
//   GITHUB_REF_NAME=v0.2.0-beta.1 npm run check:versions
//
// `--check` exits non-zero on any mismatch, so CI fails before building a
// release whose tag does not match the binary it just produced.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?(?:\+[0-9A-Za-z.-]+)?$/;

function read(rel) {
  return readFileSync(join(root, rel), 'utf8');
}
function write(rel, text) {
  writeFileSync(join(root, rel), text);
}
function fail(message) {
  console.error(`set-version: ${message}`);
  process.exit(1);
}

function fromPackageJson() {
  return JSON.parse(read('package.json')).version;
}

function fromTauriConf() {
  return JSON.parse(read('src-tauri/tauri.conf.json')).version;
}

function fromCargoToml() {
  const text = read('src-tauri/Cargo.toml');
  const section = text.indexOf('[package]');
  if (section < 0) fail('src-tauri/Cargo.toml has no [package] section');
  const match = text.slice(section).match(/^\s*version\s*=\s*"([^"]+)"/m);
  if (!match) fail('src-tauri/Cargo.toml has no package version');
  return match[1];
}

function fromCargoLock() {
  const text = read('src-tauri/Cargo.lock');
  const match = text.match(/\[\[package\]\]\r?\nname = "osmograph-desktop"\r?\nversion = "([^"]+)"/);
  if (!match) fail('src-tauri/Cargo.lock has no osmograph-desktop package');
  return match[1];
}

function currentVersions() {
  return {
    'package.json': fromPackageJson(),
    'src-tauri/Cargo.toml': fromCargoToml(),
    'src-tauri/Cargo.lock': fromCargoLock(),
    'src-tauri/tauri.conf.json': fromTauriConf(),
  };
}

function check(expectedArg) {
  // CI sets GITHUB_REF_NAME to the branch (e.g. "master") on branch pushes.
  // Only treat it as an expected version when it actually looks like a tag.
  const ref = process.env.GITHUB_REF_NAME || '';
  const candidate = expectedArg || (/^v?\d+\.\d+\.\d+/.test(ref) ? ref : '');
  const expected = candidate.replace(/^v/, '').trim();
  const versions = currentVersions();
  let bad = false;
  for (const [file, version] of Object.entries(versions)) {
    const ok = version === (expected || versions['package.json']);
    if (!ok) bad = true;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${file}: ${version}`);
  }
  if (!expected) {
    console.log(`\nNo expected version given; compared against package.json (${versions['package.json']}).`);
  } else {
    console.log(`\nExpected: ${expected}`);
  }
  if (bad) {
    console.error('\nVersion mismatch. Run: npm run set-version -- <version>');
    process.exit(1);
  }
  console.log('All versions agree.');
}

function set(version) {
  if (!SEMVER.test(version)) {
    fail(`"${version}" is not a valid version (expected e.g. 0.2.0 or 0.2.0-beta.1)`);
  }

  const pkg = JSON.parse(read('package.json'));
  pkg.version = version;
  write('package.json', `${JSON.stringify(pkg, null, 2)}\n`);

  // package-lock.json carries the root version twice.
  try {
    const lock = JSON.parse(read('package-lock.json'));
    lock.version = version;
    if (lock.packages && lock.packages['']) lock.packages[''].version = version;
    write('package-lock.json', `${JSON.stringify(lock, null, 2)}\n`);
  } catch {
    // No lockfile (or unreadable): package.json is still the source of truth.
  }

  const cargo = read('src-tauri/Cargo.toml');
  const section = cargo.indexOf('[package]');
  if (section < 0) fail('src-tauri/Cargo.toml has no [package] section');
  const before = cargo.slice(0, section);
  const after = cargo.slice(section).replace(/^(\s*version\s*=\s*")[^"]+(")/m, `$1${version}$2`);
  write('src-tauri/Cargo.toml', before + after);

  const lockText = read('src-tauri/Cargo.lock');
  const nextLock = lockText.replace(
    /(\[\[package\]\]\r?\nname = "osmograph-desktop"\r?\nversion = ")[^"]+(")/,
    `$1${version}$2`,
  );
  if (nextLock === lockText && fromCargoLock() !== version) {
    fail('could not update src-tauri/Cargo.lock');
  }
  write('src-tauri/Cargo.lock', nextLock);

  const conf = JSON.parse(read('src-tauri/tauri.conf.json'));
  conf.version = version;
  write('src-tauri/tauri.conf.json', `${JSON.stringify(conf, null, 2)}\n`);

  console.log(`Set version to ${version} in package.json, package-lock.json, Cargo.toml, Cargo.lock, tauri.conf.json.`);
  const stage = version.includes('-') ? 'prerelease' : 'stable';
  console.log(`Next: commit, then tag v${version} and push the tag. The release is published as ${stage}.`);
  console.log(stage === 'stable'
    ? 'Stable releases appear for the Stable channel and can become GitHub "latest".'
    : 'Prereleases appear for the Beta channel; GitHub "latest" stays on the newest stable.');
}

const args = process.argv.slice(2);
if (args[0] === '--check') {
  check(args[1]);
} else if (args.length === 1) {
  set(args[0].replace(/^v/, '').trim());
} else {
  console.log('Usage:');
  console.log('  node scripts/set-version.mjs <version>   set every version field');
  console.log('  node scripts/set-version.mjs --check     verify all fields agree');
  process.exit(1);
}
