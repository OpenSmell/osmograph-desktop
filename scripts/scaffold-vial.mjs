#!/usr/bin/env node
// Scaffold a domain Vial project without the app.
//
//   npm run scaffold:vial -- ./my-vial "Coffee Roast Log" "@your-handle"
//
// The generated project is deliberately small: one manifest, one host-snapshot
// fixture, and a README that states the claim and the refusal. The manifest is
// host-rendered. A Vial may add a sandboxed ui.html beside it when the domain
// screen needs more than the declarative widget vocabulary.

import fs from 'node:fs';
import path from 'node:path';

const target = process.argv[2];
const displayName = process.argv[3] || 'My Vial';
const author = process.argv[4] || '@your-handle';

if (!target) {
  console.error('Usage: npm run scaffold:vial -- <directory> ["Display name"] ["@author"]');
  process.exit(2);
}

const slug = displayName
  .toLowerCase()
  .trim()
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '')
  .slice(0, 48) || 'my-vial';

const root = path.resolve(target);
const displayPath = root.startsWith(`${process.cwd()}${path.sep}`) ? path.relative(process.cwd(), root) : root;
if (fs.existsSync(root) && fs.readdirSync(root).length > 0) {
  console.error(`Refusing to overwrite non-empty directory: ${root}`);
  process.exit(1);
}

const manifest = {
  schema: 'osmograph.domain-pack/1',
  id: `vial.${slug}`,
  name: displayName,
  version: '0.1.0',
  author,
  license: 'CC-BY-4.0',
  risk: 'medium',
  domain: 'your-domain',
  tagline: 'Track the process, not just the number.',
  summary: 'A small workspace for recording context, a local log, and a same-array change watch. Replace this scope with the one process you can actually inspect.',
  whatItIs: 'A protocol and a local log for one repeatable process. It records the context around each reading and uses the host change detector only on the same array and sample path.',
  whatItIsNot: 'Not a chemical identifier, not a concentration meter, not a safety device, not a cross-rig calibration, and not a substitute for the primary measurement in this domain.',
  citations: [
    'Replace with a real reference: author, year, title, venue, DOI or URL. A citation is context, not decoration.',
  ],
  home: {
    headline: 'One process. One array. One honest change signal.',
    detail: 'This Home card is composed by the host from a typed snapshot. It never receives raw buffers and cannot override a host refusal.',
    metrics: [
      { label: 'Scope', value: 'same device', hint: 'A baseline from another array does not transfer.' },
      { label: 'Use', value: 'change watch', hint: 'The host detector runs independently of this Vial.' },
    ],
    actions: [
      { id: 'workspace', label: 'Open workspace', kind: 'open-workspace' },
      { id: 'check', label: 'Compare two samples', kind: 'open-check' },
    ],
    limits: [
      'A change signal is not an identity, a concentration, or a safety verdict.',
      'Validate the protocol on your own array before you rely on it.',
    ],
    sources: [
      'Replace with the evidence record this Vial depends on. Link a paper, dataset, or protocol.',
    ],
  },
  widgets: [
    {
      type: 'hero',
      art: 'generic',
      title: displayName,
      subtitle: 'One process, one array, one honest change signal.',
      note: 'Author-hosted Vial · host-rendered · optional sandboxed UI',
    },
    {
      type: 'risk',
      level: 'medium',
      headline: 'Name the decision this workspace cannot make.',
      body: 'The host detector flags a sustained departure from a clean baseline. This workspace must state where that signal stops and the primary measurement starts.',
      always: [
        'Record the array, the sample path, and the clean baseline conditions.',
        'Keep the primary measurement for this domain next to every reading.',
      ],
      never: [
        'Never turn a change signal into an identity or a concentration.',
        'Never compare a reading from one array to a different array.',
      ],
    },
    {
      type: 'metrics',
      title: 'What this workspace is allowed to claim',
      items: [
        { label: 'Signal', value: 'Sustained change', hint: 'Same device, same sample path, against its own baseline.' },
        { label: 'Not', value: 'Identity or safety', hint: 'No compound name, no concentration, no safe/unsafe verdict.' },
      ],
    },
    {
      type: 'tracking',
      title: 'Process log',
      description: 'The context is part of the measurement. A reading without a process step is not a usable record.',
      fields: [
        { id: 'site', label: 'Site / process', type: 'text', placeholder: 'Bench 2 · roast batch' },
        { id: 'array', label: 'Array / rig', type: 'text', placeholder: 'array A' },
      ],
      logFields: [
        { id: 'when', label: 'When', type: 'date' },
        { id: 'context', label: 'What changed', type: 'text', placeholder: 'cleaning, door, process step' },
        { id: 'action', label: 'Action', type: 'select', options: ['none', 'inspect', 're-baseline', 'stop'] },
      ],
      logLabel: 'Add reading',
    },
    {
      type: 'rules',
      title: 'Stop rules',
      rules: [
        {
          when: 'A sustained change has no obvious benign cause',
          then: 'Stop the process, inspect, and verify with the primary measurement. Do not treat the alert as an identification.',
          severity: 'stop',
        },
        {
          when: 'You move the array or change the sample path',
          then: 'Re-baseline. The old baseline belongs to the old physical setup.',
          severity: 'warn',
        },
      ],
    },
    { type: 'docs', title: 'Field notes' },
    {
      type: 'rig',
      title: 'Use this with your rig',
      body: 'Record a clean reference and a sample on the same array and sample path, then compare them in Check. The app refuses comparisons across different arrays.',
      cta: 'Open Check',
    },
  ],
  docs: [
    {
      id: 'use',
      title: 'How to use this workspace',
      body: [
        'Describe the one process this workspace supports. Replace the placeholder fields with the context you will actually record.',
        'Run the host detector on a clean baseline. A warming-up state never alarms. Do not arm the workspace until the baseline is ready.',
      ],
    },
    {
      id: 'limits',
      title: 'What it cannot do',
      body: [
        'It cannot identify a compound, measure concentration, or certify safety. Those claims need a different instrument and a different evidence record.',
        'It cannot transfer a baseline from another array, enclosure, or sample path. Re-baseline after any physical change.',
      ],
    },
  ],
};

const snapshot = {
  schema: 'osmograph.vial-host/1',
  takenAt: 0,
  source: 'none',
  samplingMode: 'unknown',
  channels: [],
  environment: null,
  baseline: { state: 'none', progress: 0, ageSec: null },
  anomaly: { state: 'unknown', score: null, confidence: null, alertLevel: 0, triggeredChannels: 0, consecutive: 0 },
  classifier: { state: 'none', name: null, label: null, confidence: null },
};

const readme = `# ${displayName}

An author-hosted Vial for Osmograph. The manifest is validated data. The Vial
may stay declarative, or add a sandboxed \`ui.html\` beside the manifest when the
domain screen needs more than the widget vocabulary.

## Files

| Path | Purpose |
|---|---|
| \`vial.json\` | The manifest Osmograph validates and installs. |
| \`ui.html\` | Optional sandboxed UI body fragment, beside the manifest. |
| \`fixtures/host-snapshot.json\` | The typed host state this Vial may depend on. |
| \`README.md\` | The claim, the refusal, and the install path. |

## Validate

From the Osmograph desktop repository:

\`\`\`bash
npm run validate:vial -- ${displayPath}
\`\`\`

The validator runs the same local policy gate as import. If you add a
\`ui.html\`, it checks that fragment against the sandbox rules too. A pass is
necessary, not sufficient: it is not a security audit or a domain review.

## Optional sandboxed UI

Add this to the manifest and put \`ui.html\` beside it:

\`\`\`json
"ui": { "runtime": "sandbox/1", "entry": "ui.html", "height": 900 }
\`\`\`

The UI is a body fragment in an iframe with no network, storage, forms, frames,
or Tauri access. It receives a typed \`osmograph.vial-runtime/1\` payload and can
only call the documented actions. A Vial with a UI must be installed from its
manifest URL so the host can fetch \`ui.html\` beside it; a local file import
cannot carry the asset.

## Test the Home contribution

The host composes the Home card from \`home\` plus a \`VialHostSnapshot\`. The
fixture is the empty state. Add live, warming, and attention fixtures when you
test the protocol on a rig.

## Install on your machine

1. Open **Vials → Aromatory → Import .vial.json** and choose this file.
2. Open the workspace and check that every widget renders.
3. Add one reading and confirm the log stays local.
4. Connect a rig, establish a clean baseline, and verify the Home card changes
   from \`No rig\` to \`Live\` without changing the underlying detector.

## Publish from your own GitHub

Put \`vial.json\` and, if used, \`ui.html\` in a repository you control and use the
raw URL:

\`\`\`text
https://raw.githubusercontent.com/<you>/<repo>/main/vial.json
\`\`\`

Paste that URL into **Vials → Aromatory → Install from URL**. To request a
listing in the public Aromatory, add one entry to
\`opensmell-web/public/vials/registry.json\`. A listing is discovery, not
endorsement.

## Before you publish

- Replace every placeholder field and citation.
- State the one process, the one array, and the primary measurement.
- Keep the refusal in \`whatItIsNot\` and in \`home.limits\`.
- Link the evidence in \`home.sources\`. If there is no evidence yet, say so.
- Do not claim identity, concentration, cross-rig transfer, safety, or a
  universal smell result.
`;

fs.mkdirSync(path.join(root, 'fixtures'), { recursive: true });
fs.writeFileSync(path.join(root, 'vial.json'), `${JSON.stringify(manifest, null, 2)}\n`);
fs.writeFileSync(path.join(root, 'fixtures', 'host-snapshot.json'), `${JSON.stringify(snapshot, null, 2)}\n`);
fs.writeFileSync(path.join(root, 'README.md'), readme);

console.log(`Scaffolded ${manifest.id} in ${root}`);
console.log(`Next: edit vial.json, then validate with:`);
console.log(`  npm run validate:vial -- ${displayPath}`);
