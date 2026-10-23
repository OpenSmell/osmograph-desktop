#!/usr/bin/env node
// Validate an author-hosted Vial project without launching the app.
//
//   npm run validate:vial -- examples/example-coffee-roast.vial.json
//   npm run validate:vial -- my-vial/
//
// The check is the same policy gate used on import (src/domainPacks.ts). If the
// manifest declares a sandboxed UI, the companion ui.html beside it is checked
// against the runtime fragment rules as well. This is a local, heuristic gate,
// not a security certification or a domain review.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = process.argv[2];

if (!target) {
  console.error('Usage: npm run validate:vial -- <file.vial.json|project-dir>');
  process.exit(2);
}

async function loadModule(relativePath) {
  const source = fs.readFileSync(path.join(root, relativePath), 'utf8');
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);
}

function resolveProject(input) {
  const resolved = path.resolve(input);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Path does not exist: ${input}`);
  }
  if (fs.statSync(resolved).isFile()) {
    return { manifest: resolved, dir: path.dirname(resolved) };
  }
  const direct = path.join(resolved, 'vial.json');
  if (fs.existsSync(direct)) return { manifest: direct, dir: resolved };
  const candidates = fs.readdirSync(resolved)
    .filter((name) => name.endsWith('.vial.json'))
    .map((name) => path.join(resolved, name));
  if (candidates.length === 0) {
    throw new Error(`No vial.json or *.vial.json found in ${input}`);
  }
  if (candidates.length > 1) {
    throw new Error(`Multiple manifests found in ${input}; pass the exact file or add vial.json`);
  }
  return { manifest: candidates[0], dir: resolved };
}

let project;
try {
  project = resolveProject(target);
} catch (err) {
  console.error(`FAIL ${target}: ${err.message}`);
  process.exit(2);
}

let Domain;
let Runtime;
try {
  Domain = await loadModule('src/domainPacks.ts');
  Runtime = await loadModule('src/vialRuntime.ts');
} catch (err) {
  console.error(`Could not load the validator: ${err.message}`);
  process.exit(2);
}

let raw;
try {
  raw = fs.readFileSync(project.manifest, 'utf8');
} catch (err) {
  console.error(`Could not read ${project.manifest}: ${err.message}`);
  process.exit(2);
}

let result;
try {
  result = Domain.inspectDomainPackJson(raw);
} catch (err) {
  console.error(`FAIL ${project.manifest}: ${err.message}`);
  process.exit(1);
}

const { pack, validation } = result;
const passed = validation.checks.filter((c) => c.passed).length;
const total = validation.checks.length;
let uiError = '';

for (const [label, spec] of [['ui-asset', pack.ui], ['home-ui-asset', pack.homeUi]]) {
  if (!spec) continue;
  const uiPath = path.join(project.dir, spec.entry);
  if (!fs.existsSync(uiPath)) {
    uiError = `${label}: ${spec.entry} is declared but missing beside the manifest.`;
    break;
  }
  try {
    Runtime.assertSandboxableUi(fs.readFileSync(uiPath, 'utf8'));
  } catch (err) {
    uiError = `${label}: ${err instanceof Error ? err.message : String(err)}`;
    break;
  }
}

const ok = validation.passed && !uiError;
console.log(`${ok ? 'PASS' : 'FAIL'} ${pack.id}@${pack.version} — ${passed}/${total} policy checks`);
for (const check of validation.checks) {
  if (!check.passed) console.log(`  ${check.critical ? 'ERROR' : 'warn '} ${check.id}: ${check.detail}`);
}
for (const warning of validation.warnings) console.log(`  warn  ${warning}`);
if (uiError) console.log(`  ERROR ${uiError}`);
process.exit(ok ? 0 : 1);
