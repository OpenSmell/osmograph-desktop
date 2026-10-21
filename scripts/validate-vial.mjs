#!/usr/bin/env node
// Validate a community domain Vial without launching the app.
//
//   npm run validate:vial -- examples/community-workspace.vial.json
//
// The check is the same policy gate used on import (src/domainPacks.ts). It is
// a local, heuristic gate, not a security certification or a domain review.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourcePath = path.join(root, 'src', 'domainPacks.ts');
const file = process.argv[2];

if (!file) {
  console.error('Usage: npm run validate:vial -- <file.vial.json>');
  process.exit(2);
}

let source;
try {
  source = fs.readFileSync(sourcePath, 'utf8');
} catch (err) {
  console.error(`Could not read ${sourcePath}: ${err.message}`);
  process.exit(2);
}

const js = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
}).outputText;
const mod = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);

let raw;
try {
  raw = fs.readFileSync(path.resolve(file), 'utf8');
} catch (err) {
  console.error(`Could not read ${file}: ${err.message}`);
  process.exit(2);
}

try {
  const { pack, validation } = mod.inspectDomainPackJson(raw);
  const passed = validation.checks.filter(c => c.passed).length;
  const total = validation.checks.length;
  console.log(`${validation.passed ? 'PASS' : 'FAIL'} ${pack.id}@${pack.version} — ${passed}/${total} policy checks`);
  for (const check of validation.checks) {
    if (!check.passed) console.log(`  ${check.critical ? 'ERROR' : 'warn '} ${check.id}: ${check.detail}`);
  }
  for (const warning of validation.warnings) console.log(`  warn  ${warning}`);
  process.exit(validation.passed ? 0 : 1);
} catch (err) {
  console.error(`FAIL ${file}: ${err.message}`);
  process.exit(1);
}
