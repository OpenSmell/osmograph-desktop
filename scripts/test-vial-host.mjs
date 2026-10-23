#!/usr/bin/env node
// Contract tests for the Vial host bridge. No app, no browser, no Tauri.
//
//   npm run test:vial-host

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = fs.readFileSync(path.join(root, 'src', 'vialHost.ts'), 'utf8');
const js = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
}).outputText;
const Host = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);

const fixture = (name) => JSON.parse(fs.readFileSync(path.join(root, 'fixtures', 'vial-host', `${name}.json`), 'utf8'));

const spec = {
  headline: 'One process. One array.',
  detail: 'A bounded Home card.',
  metrics: [{ label: 'Scope', value: 'same device' }],
  actions: [{ id: 'workspace', label: 'Open workspace', kind: 'open-workspace' }],
  limits: ['A change signal is not an identity.'],
  sources: ['TADI-2019, doi:10.5281/zenodo.8399829'],
};
const pack = { id: 'vial.test', name: 'Test Vial', home: spec };

const idle = Host.homeContributionFor(pack, fixture('empty'));
assert.equal(idle.state, 'idle');
assert.equal(idle.schema, 'osmograph.vial-home/1');
assert.equal(idle.runtime[0].value, 'not armed');
assert.equal(Host.validateHomeContribution(idle).ok, true);

const warming = Host.homeContributionFor(pack, fixture('warming'));
assert.equal(warming.state, 'warming');
assert.match(warming.runtime[0].value, /42%/);

const attention = Host.homeContributionFor(pack, fixture('attention'));
assert.equal(attention.state, 'attention');
assert.match(attention.runtime[0].value, /warning/);

const classified = Host.homeContributionFor(pack, fixture('classifier'));
assert.equal(classified.state, 'ready');
assert.match(classified.runtime[0].value, /cinnamon/);

const invalid = Host.validateHomeContribution({ ...idle, sources: [] });
assert.equal(invalid.ok, false);
assert.match(invalid.errors.join(' '), /source/);

assert.equal(Host.homeContributionFor({ id: 'x', name: 'x' }, idle), null);

console.log('PASS vial host contract — idle, warming, attention, classifier, refusal');
