#!/usr/bin/env node
// Create (or reuse) the minisign keypair that signs update artifacts, and put
// the public half into tauri.conf.json. The private half never enters the repo.
//
//   npm run setup:updater-keys
//   npm run setup:updater-keys -- --print-public
//   npm run setup:updater-keys -- --force   # rotation: read the warning first
//
// The private key is written to ~/.config/osmograph/updater.key (mode 600) and
// is printed nowhere. Add its contents to the TAURI_SIGNING_PRIVATE_KEY GitHub
// secret, and the password file to TAURI_SIGNING_PRIVATE_KEY_PASSWORD.

import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const args = new Set(process.argv.slice(2));
const force = args.has('--force');
const printPublic = args.has('--print-public');

const keyDir = process.env.OSMOGRAPH_KEY_DIR || join(homedir(), '.config', 'osmograph');
const keyPath = join(keyDir, 'updater.key');
const passwordPath = join(keyDir, 'updater.key.password');
const publicPath = `${keyPath}.pub`;
const confPath = join(root, 'src-tauri', 'tauri.conf.json');

function fail(message) {
  console.error(`setup-updater-keys: ${message}`);
  process.exit(1);
}

function readPublic() {
  if (!existsSync(publicPath)) return '';
  return readFileSync(publicPath, 'utf8').trim();
}

function patchConfig(publicKey) {
  const conf = JSON.parse(readFileSync(confPath, 'utf8'));
  conf.plugins = conf.plugins || {};
  conf.plugins.updater = conf.plugins.updater || {};
  conf.plugins.updater.pubkey = publicKey;
  conf.plugins.updater.endpoints = conf.plugins.updater.endpoints || [
    'https://github.com/OpenSmell/osmograph-desktop/releases/latest/download/latest.json',
  ];
  conf.plugins.updater.windows = {
    installMode: 'quiet',
    ...(conf.plugins.updater.windows || {}),
  };
  writeFileSync(confPath, `${JSON.stringify(conf, null, 2)}\n`);
}

if (printPublic) {
  const pub = readPublic();
  if (!pub) fail(`no public key at ${publicPath}; run without --print-public first`);
  console.log(pub);
  process.exit(0);
}

if (existsSync(keyPath) && !force) {
  const pub = readPublic();
  if (!pub) fail(`private key exists at ${keyPath} but ${publicPath} is missing; back up the key, then use --force to rotate`);
  patchConfig(pub);
  console.log('Updater key already exists; tauri.conf.json now carries its public half.');
  printInstructions();
  process.exit(0);
}

if (force && existsSync(keyPath)) {
  console.error('WARNING: rotating the updater key breaks every install that embeds the old public key.');
  console.error('Ship a bridge release signed with the old key first, or accept that users must download manually once.');
}

mkdirSync(keyDir, { recursive: true, mode: 0o700 });
const password = randomBytes(24).toString('base64url');
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
try {
  execFileSync(
    npx,
    ['tauri', 'signer', 'generate', '--ci', '-p', password, '-w', keyPath, ...(force ? ['--force'] : [])],
    { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] },
  );
} catch (error) {
  const detail = error?.stderr?.toString?.().trim() || error?.message || String(error);
  fail(`could not generate the keypair: ${detail}`);
}

if (!existsSync(keyPath) || !existsSync(publicPath)) {
  fail(`the Tauri CLI did not write ${keyPath} and ${publicPath}`);
}

chmodSync(keyPath, 0o600);
writeFileSync(passwordPath, `${password}\n`, { mode: 0o600 });
chmodSync(passwordPath, 0o600);

const pub = readPublic();
if (!pub) fail('the generated public key is empty');
patchConfig(pub);

console.log('Updater signing key generated.');
printInstructions();

function printInstructions() {
  console.log('');
  console.log('Public key: written to src-tauri/tauri.conf.json');
  console.log(`Private key: ${keyPath} (mode 600, never commit it)`);
  console.log(`Password:    ${passwordPath} (mode 600)`);
  console.log('');
  console.log('Add both as GitHub repository secrets (Settings → Secrets and variables → Actions):');
  console.log('  TAURI_SIGNING_PRIVATE_KEY          ← contents of the private-key file');
  console.log('  TAURI_SIGNING_PRIVATE_KEY_PASSWORD ← contents of the password file');
  console.log('');
  console.log('Back up both files. Installed builds embed only the public key; if you lose');
  console.log('the private key or password, those builds cannot verify your next update.');
}
