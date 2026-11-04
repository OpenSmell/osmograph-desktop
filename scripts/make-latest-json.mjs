#!/usr/bin/env node
// Build the static Tauri updater manifest from a directory of signed release
// assets. Run in the publish job after every platform artifact is downloaded.
//
//   node scripts/make-latest-json.mjs \
//     --dir release-assets --tag v0.1.2-beta.2 \
//     --repo OpenSmell/osmograph-desktop --out release-assets/latest.json
//
// A platform is only included when both the artifact and its `.sig` exist.
// An unsigned artifact fails the release instead of advertising an update the
// app cannot verify. Signatures are the *contents* of the `.sig` file.

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SIG = '.sig';
const IGNORED = /(^|\/)(latest\.json|SHA256SUMS\.txt)$/i;

function archFromName(name, fallback = null) {
  const lower = name.toLowerCase();
  if (/(aarch64|arm64)/.test(lower)) return 'aarch64';
  if (/(x86_64|amd64|x64)/.test(lower)) return 'x86_64';
  return fallback;
}

/** Map a release asset name to the updater target key, or null when the asset
 * cannot be installed in place (dmg, sums, manifest, signatures). */
export function platformKeyFor(name) {
  const lower = name.toLowerCase();
  if (lower.endsWith(SIG) || IGNORED.test(name)) return null;
  if (lower.endsWith('.appimage')) {
    const arch = archFromName(name);
    return arch ? `linux-${arch}-appimage` : null;
  }
  if (lower.endsWith('.deb')) {
    const arch = archFromName(name);
    return arch ? `linux-${arch}-deb` : null;
  }
  if (lower.endsWith('.rpm')) {
    const arch = archFromName(name);
    return arch ? `linux-${arch}-rpm` : null;
  }
  if (lower.endsWith('.app.tar.gz')) {
    const arch = archFromName(name);
    return arch ? `darwin-${arch}-app` : null;
  }
  if (lower.endsWith('.exe')) {
    return `windows-${archFromName(name, 'x86_64')}-nsis`;
  }
  if (lower.endsWith('.msi')) {
    return `windows-${archFromName(name, 'x86_64')}-msi`;
  }
  // .dmg is a browser installer, not an updater payload.
  return null;
}

/** Prefer the friendly alias over a version-stamped duplicate when both are
 * present in the merged artifact directory. */
function preference(name) {
  return name.includes('_') ? 1 : 0;
}

export function buildManifest({ assets, tag, repo, now = new Date() }) {
  if (!/^v?\d+\.\d+\.\d+/.test(tag)) {
    throw new Error(`tag "${tag}" does not look like a release version`);
  }
  if (!/^[^/]+\/[^/]+$/.test(repo)) {
    throw new Error(`repo "${repo}" is not owner/name`);
  }

  const signatures = new Map();
  for (const asset of assets) {
    if (!asset.name.endsWith(SIG)) continue;
    const target = asset.name.slice(0, -SIG.length);
    signatures.set(target, asset.contents.trim());
  }

  const chosen = new Map();
  const unsigned = [];
  for (const asset of assets) {
    const key = platformKeyFor(asset.name);
    if (!key) continue;
    if (!signatures.get(asset.name)) {
      unsigned.push(asset.name);
      continue;
    }
    const previous = chosen.get(key);
    if (!previous || preference(asset.name) < preference(previous.name)) {
      chosen.set(key, asset);
    }
  }

  if (unsigned.length) {
    throw new Error(
      `refusing to publish an updater manifest with unsigned artifacts: ${unsigned.join(', ')}`,
    );
  }
  if (chosen.size === 0) {
    throw new Error(
      'no signed updater artifacts found; expected .AppImage/.deb/.rpm, .exe/.msi, or .app.tar.gz plus .sig files',
    );
  }

  const version = tag.replace(/^v/, '');
  const platforms = {};
  for (const key of [...chosen.keys()].sort()) {
    const asset = chosen.get(key);
    platforms[key] = {
      signature: signatures.get(asset.name),
      url: `https://github.com/${repo}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(asset.name)}`,
    };
  }

  return {
    version,
    pub_date: now.toISOString(),
    platforms,
  };
}

function readAssets(dir) {
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => ({
      name: entry.name,
      // Only signatures are read; installers can be hundreds of MB.
      contents: entry.name.endsWith(SIG)
        ? readFileSync(join(dir, entry.name), 'utf8')
        : '',
    }));
}

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function main() {
  const dir = resolve(arg('dir', 'release-assets'));
  const tag = arg('tag', process.env.GITHUB_REF_NAME || '');
  const repo = arg('repo', process.env.GITHUB_REPOSITORY || 'OpenSmell/osmograph-desktop');
  const out = resolve(arg('out', join(dir, 'latest.json')));

  if (!existsSync(dir)) {
    console.error(`make-latest-json: artifact directory not found: ${dir}`);
    process.exit(1);
  }
  if (!tag) {
    console.error('make-latest-json: --tag (or GITHUB_REF_NAME) is required');
    process.exit(1);
  }

  let manifest;
  try {
    manifest = buildManifest({ assets: readAssets(dir), tag, repo });
  } catch (error) {
    console.error(`make-latest-json: ${error.message}`);
    process.exit(1);
  }

  writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Wrote ${out}`);
  console.log(`  version ${manifest.version}`);
  for (const [key, entry] of Object.entries(manifest.platforms)) {
    console.log(`  ${key.padEnd(28)} ${entry.url}`);
  }
}

const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) main();
