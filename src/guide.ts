// The in-app field guide. Every claim-bearing surface should be able to point
// here. Keep this honest: it documents what the software actually does, what it
// refuses to do, and what would have to be true before a stronger claim is made.

export interface GuideSection {
  id: string;
  group: 'Start' | 'Methods' | 'Vials' | 'Data' | 'Reference';
  title: string;
  summary: string;
  paragraphs: string[];
  bullets?: string[];
}

export const GUIDE_SECTIONS: GuideSection[] = [
  {
    id: 'start',
    group: 'Start',
    title: 'Start here: what Osmograph is',
    summary: 'A local-first workbench for digitising the experiment around a smell.',
    paragraphs: [
      'Osmograph turns a gas-sensor recording into a reproducible comparison: this sample, on this array, against this reference, under this method. The core objects are Session, Recipe, Result, Experiment, Check, Vial, and Library.',
      'A sensor response is a mixture. The useful claim is a closed-set, same-array comparison with the uncertainty and limits attached; identity, concentration, and safety decisions each need their own primary measurement.',
      'The quickest first loop is: open Explore → Datasets, download the public SmellNet sensor set from Hugging Face, then tick two smells → Analyse → Compare → read the same-array guard and the difference wheel → save a Separability result. Nothing is preloaded.',
      'The app is organised by job: Home, Explore, Analyse, Vials, and Fleet, with Settings and the Field Guide as utilities. Hardware controls appear on Home and Fleet; Explore, Analyse, and Vials work without a rig.',
    ],
    bullets: [
      'No hardware? Download a real public corpus from Explore → Datasets, then use Gallery and Compare.',
      'Have a rig? Capture a baseline and a sample on the same channels, then use Separability.',
      'Want a reusable decision? Package a saved Separability result as a Vial, or install a Domain Vial for a field protocol.',
    ],
  },
  {
    id: 'claims',
    group: 'Methods',
    title: 'The claim ladder',
    summary: 'Each rung needs more evidence. Never skip a rung in public language.',
    paragraphs: [
      'The software separates four kinds of statement. They are related, but they are not interchangeable.',
    ],
    bullets: [
      'Observation: “these recordings differ on this array.” Cheap, local, and easy to over-read.',
      'Separability: “on this array, this reference and this sample are distinguishable under this method.” Adds a paired comparison, a permutation test, and a lower confidence bound. The class matrix shows the same evidence for every pair at once.',
      'Gated Vial: “this closed-set decision passed the local validation gate, with its array, limits, evidence, and method attached.” The claim is scoped to that array and preparation; a signature, if one exists, is external and is recorded separately.',
      'Decision: “use this Vial for this narrow, repeated choice.” Only valid inside the declared scope and only with the declared sample preparation.',
    ],
  },
  {
    id: 'fingerprints',
    group: 'Methods',
    title: 'Fingerprints and the difference wheel',
    summary: 'A fingerprint is a signed, normalised response shape for comparison on one array.',
    paragraphs: [
      'Gallery cards show a compact radar: the mean settled response of each channel on the dominant array, normalised against its own baseline and drawn on one scale. It is a visual hash for scanning the library.',
      'Open a smell and the detail view shows the evidence behind that hash: one small panel per channel, thin lines for each replicate, a bold line for their mean, and relative time left to right. That is where kinetics and replicate spread become visible. The detail view is a static summary of recordings. The inspector now also has an Over time view, and Replay has a fingerprint evolution heatmap, so the transformation is visible without pretending the mean is the whole story.',
      'The signed difference wheel is the comparison view. Positive values point outward in teal; negative values point inward in amber; a zero ring separates them. It is a compact comparison of settled responses.',
      'The same-array guard is a hard rule. If the reference and sample do not share the same channel set, the comparison is refused. A six-channel SmellNet fingerprint and a user rig fingerprint are not the same object, even if both have six numbers.',
    ],
    bullets: [
      'Same array only. Order and channel identity matter.',
      'Normalised, not absolute. The number is not ppm or concentration.',
      'A fingerprint is evidence of a response pattern. Species identification needs its own primary evidence.',
    ],
  },
  {
    id: 'check',
    group: 'Methods',
    title: 'How Separability works',
    summary: 'A baseline-relative, paired comparison with an explicit uncertainty and a permutation test.',
    paragraphs: [
      'The current method is check.baseline-relative.v1, “Baseline-relative fingerprint check”, version 1.0.0. It has three steps: normalise each recording to its own baseline, compare the signed channel differences, and estimate whether the observed separation could arise by chance.',
      'The class matrix scores every pair of classes without the permutation test, so it stays responsive. Open a cell and the pair bench reports the number of held-out evaluations, a separation verdict, a 95% Wilson lower bound on the paired success rate, and a permutation p-value. Read the interval with the point estimate, and report the effect size alongside the p-value.',
      'The verdicts are deliberately plain: separable, fragile, confusable, insufficient. Use the matrix to choose which classes are ready for Train, then use Train to select the actual recordings. “Fragile” means the comparison worked in this sample but the evidence is not strong enough for the local decision gate. “Insufficient” means there are not enough paired evaluations to say anything useful.',
    ],
    bullets: [
      'Method: check.baseline-relative.v1 · version 1.0.0.',
      'Pairing: the reference and sample must share the same array channels.',
      'Statistics: paired held-out evaluations, Wilson lower bound, permutation p-value.',
      'Refusal: no cross-rig comparison, no absolute concentration, no chemical identification.',
    ],
  },
  {
    id: 'recipes',
    group: 'Methods',
    title: 'Transforms, trim, and replay',
    summary: 'A transform pipeline is a named chain of deterministic operations on a response.',
    paragraphs: [
      'Use Analyse → Transforms, or select a recording in Explore → Recordings and press Trim. A transform pipeline binds to one indexed recording, runs named transforms in order, previews the result, and can save the result as a new .osmell recording. The original is never overwritten.',
      'Runnable transforms include trim.range (cut to start/end seconds), gap fill, outlier removal, smoothing, detrending, baseline selection, response ratio, R0 normalization, and min-max/z-score scaling. Catalogued-but-unimplemented transforms are not presented as working.',
      'Replay plays a recorded session at 0.5×–8× with a scrub bar. The dashboard fingerprint reflects the replayed moment, and the Replay panel adds a signed fingerprint-evolution heatmap plus a current trailing-window radar. Replay does not feed the live detector or classifier. A saved Separability result is a snapshot of a verdict; reopening it recomputes against the current library.',
    ],
    bullets: [
      'A transform pipeline cannot change its source recording in place.',
      'Saving creates a derived recording; export it to move it.',
      'A derived recording is not independent evidence.',
    ],
  },
  {
    id: 'vials',
    group: 'Vials',
    title: 'What a Vial is — and what "gated" means',
    summary: 'A Vial is a programmable anomaly app: a profile program, a sandboxed domain UI, and evidence.',
    paragraphs: [
      'A v2 Vial packages three things: an anomaly profile (baseline, transforms, per-channel limits, min-channel corroboration, persistence, hysteresis, escalation, admissibility, and a false-alarm target), a sandboxed domain UI or declarative workspace, and a held-out evidence block with fixtures. The host compiles the profile into a detector owned by that Vial; the UI interprets the host snapshot and cannot change the detector.',
      'The local gate checks the schema, the profile ranges, the evidence block, citations, the sandbox, and placeholders. “Open” means the local gate failed and the UI labels the Vial Ungated. “Gated” means every critical check passed. A registry listing adds a human review of the claim and its evidence, and pins the manifest sha256 and every UI asset sha256.',
      'A listing is scoped to the declared array and preparation. A signature is external and is not minted locally. Every install re-runs the gate and verifies the pinned bytes; an update is a second, verified install.',
    ],
    bullets: [
      'Gated is a local evidence status. A registry listing records human review; neither is a signature.',
      'Cross-rig generalisation needs its own calibration evidence.',
      'The separate Decisions tab keeps a saved Separability result as a local decision record. A domain Vial is a programmable app with its own profile, UI, and evidence.',
    ],
  },
  {
    id: 'domain',
    group: 'Vials',
    title: 'Domain Vials: protocols, logs, and honest limits',
    summary: 'A domain Vial carries a way of working beyond a pairwise verdict. Any Vial may stay declarative or add a sandboxed UI.',
    paragraphs: [
      'A domain Vial ships a protocol, a log, a scope model, decision rules, field notes, citations, and a workspace. The host renders the declarative workspace from the manifest. A Vial may also add a sandboxed ui.html beside the manifest: a body fragment in an iframe with no network, storage, forms, frames, or Tauri access, fed by a typed host payload. A compact Home view can be added as home.html. Every author gets the same runtime and the same policy gate.',
      'Fermentation Lab is author-hosted. Its first panel is the batch record, its stop rules point at the primary measurement, and its Home view is built from the same log and array data. Plant Respiration is author-hosted and declarative; its constants table has no ethylene channel, so a change signal is the starting point for a primary pest or pathogen check. Anomaly Watch is retired: the host owns the always-on anomaly signal, and each domain Vial owns the interpretation.',
      'Domain Vials are where domain knowledge becomes useful: a batch log with pH, temperature, salt, and visual cues; a plant log with light, water, leaf, and root context; stop rules that tell you when to discard or inspect. The sensor stays one column in a larger record.',
    ],
    bullets: [
      'Scope and stop rules are explicit: what the record can support, and when to stop or inspect.',
      'Every domain pack states its scope and the conditions it refuses.',
      'The log is stored locally and can be exported or cleared with site data.',
      'A sandboxed UI can use live or recorded sensor windows, but it cannot call Tauri, reach the network, or invent a second detector.',
      'A Vial can be installed from its manifest URL. A Vial with a workspace or Home UI must be installed from its URL so the host can fetch ui.html and home.html beside it.',
    ],
  },
  {
    id: 'authoring',
    group: 'Vials',
    title: 'Authoring a domain Vial',
    summary: 'An author-hosted Vial is a manifest you can export, version, and share, with an optional sandboxed UI.',
    paragraphs: [
      'Scaffold with noses new, then edit the id, author, licence, scope, operating envelope, citations, anomaly profile, and evidence. The full schema and widget vocabulary are in the website Vial tutorials. Every author-hosted Vial runs through the same host gate.',
      'The manifest uses schema osmograph.domain-pack/2. It must declare the anomaly profile (baseline, transforms, detection, persistence, hysteresis, escalation), the scope, the operating envelope, citations, and a held-out evidence block with at least one fixture. Packs that touch safety-critical decisions need an explicit stop rule and at least three field-note sections.',
      'Validate without launching the app with noses lint and noses test. noses test runs the declaration fixtures against the profile state machine and checks the sandbox bridge surface. A Vial with a UI must be installed from its URL so the host can fetch and hash the assets beside the manifest.',
      'The registry pins the author, version, source, manifest sha256, and every UI asset sha256. The host re-runs the same gate and verifies those hashes on every install, and the Aromatory offers an update when the registry pins a newer version. A listing records a human review of the claim and its evidence; the host gate remains the authority at install.',
    ],
    bullets: [
      'The manifest stays declarative. Executable frontend code belongs in the separate ui.html or home.html and runs in the sandbox.',
      'Every author gets the same sandboxed UI runtime and the same policy gate.',
      'Use a real author, licence, and citations, and declare the operating envelope.',
      'Put the manifest and optional ui.html/home.html in your own repo; install from the raw HTTPS manifest URL.',
      'Export, re-import, and test the rendered workspace before you share it.',
      'Claims stay inside the declared scope: identity, concentration, diagnosis, and cross-rig transfer each need their own evidence.',
    ],
  },
  {
    id: 'data',
    group: 'Data',
    title: 'Data provenance and licensing',
    summary: 'Bundled, fetched, and linked data are different. Attribution travels with the data.',
    paragraphs: [
      'SmellNet is downloaded from its original Hugging Face release, not bundled. It is MIT licensed by the MIT Media Lab and MIT EECS. The public channel order is NO2, C2H5OH, VOC, CO, Alcohol, LPG; the app stores user arrays in the user order and never blends arrays.',
      'Food Freshness (Zenodo) and the TADI methane release corpus are CC BY 4.0. UCI datasets remain reference-only because their terms conflict. The dataset catalog records the licence, credit, and download policy for each entry; the canonical attribution record is NOTICE.md.',
      'If you import your own data, it stays local. If you download a public dataset, the app records where it came from. Reference-only datasets are not shown as download buttons.',
    ],
    bullets: [
      'SmellNet: MIT licence, MIT Media Lab + MIT EECS. No MIT endorsement of this app.',
      'Food Freshness and TADI: CC BY 4.0. Keep attribution with redistributed copies.',
      'UCI: reference-only. Do not assume redistribution rights.',
    ],
  },
  {
    id: 'privacy',
    group: 'Data',
    title: 'Privacy, storage, and control',
    summary: 'Recordings and decisions are local. You should be able to inspect, export, and delete them.',
    paragraphs: [
      'Sessions live on disk in the app data directory. Saved checks use localStorage key osmograph.checks.v1; Vials use osmograph.vials.v1; domain-pack installs use osmograph.domain.installed.v1 and their logs use osmograph.domain.state.v1. These are local to this installation.',
      'The desktop app does not ship product analytics. Network access happens for explicit actions such as checking for a release, downloading a public dataset, or fetching from a configured source. Those actions are visible in the UI.',
      'Before sharing a Vial or a session, inspect it. A Vial can contain smell names, dates, usage counts, and provenance. Export is explicit; there is no silent upload.',
    ],
    bullets: [
      'Local storage keys are documented so you can inspect or clear them.',
      'Export a Vial as .vial.json; import it on another install.',
      'Deleting a session removes the local recording. Deleting a Vial is a local action.',
    ],
  },
  {
    id: 'tutorials',
    group: 'Start',
    title: 'Tutorials: the first 30 minutes',
    summary: 'Three short loops that produce something useful without pretending to have a lab.',
    paragraphs: [
      'Tutorial A — read a fingerprint. Download SmellNet in Explore → Datasets. Open Explore → Gallery, pick Banana, and read the per-channel curves, the replicate spread, the channel count, and rig health. Then tick Banana and Apple, press Compare, and read the same-array guard, the per-channel overlay, and the verdict. You have just inspected a real, labelled comparison.',
      'Tutorial B — save a Separability result. In Analyse → Separability, read the class matrix, then choose a reference and a sample from the same array. Run the pair. Read the lower bound and the p-value, not just the badge. Save the result. Now open Vials → Decisions to keep the record. Read the validation gate before you rely on the result.',
      'Tutorial C — install a Domain Vial. Open Vials → Aromatory, install Fermentation Lab, and read its scope and stop rules before the log. Add one reading with a pH, temperature, and visual note. The point is the record, not the sensor trace. Then open Plant Respiration and read its “no ethylene channel” limit.',
    ],
  },
  {
    id: 'limits',
    group: 'Reference',
    title: 'Known limits (read before claiming)',
    summary: 'The refusal list is part of the product.',
    paragraphs: [
      'These limits are current engineering truths. If a future version removes one, the change needs evidence and a migration story.',
    ],
    bullets: [
      'No universal smell ID. The same molecule can smell different; the same smell can come from different mixtures.',
      'No absolute concentration from the current normalised fingerprints. The number is a response shape.',
      'No cross-rig claim without calibration. Arrays, channel order, humidity, temperature, and sensor history change the response.',
      'No safety verdict. Fermentation and plant packs make this explicit; a pleasant smell cannot clear a batch.',
      'No ethylene channel in the current constants table. Do not use the app to decide whether fruit will ripen.',
      'MOX sensors drift, saturate, and can be poisoned by strong VOCs. A changed sensor can look like a changed sample.',
    ],
  },
  {
    id: 'glossary',
    group: 'Reference',
    title: 'Glossary',
    summary: 'Short definitions for the words the interface uses.',
    paragraphs: [
      'Array: the set of gas-sensor channels in a recording. Channel order and identity matter.',
      'Baseline-relative: each channel is normalised to its own opening baseline before comparison.',
      'Separability: a paired, same-array comparison with a verdict, a confidence bound, and a p-value. The class matrix is the multi-class view of the same method.',
      'Domain Vial: a declarative workspace with a protocol, log, scope model, rules, and docs.',
      'Fingerprint: the mean settled baseline-relative response per channel on the dominant array. Gallery cards draw it as a compact radar; the detail view shows the per-channel curves and replicates.',
      'Permutation p-value: the probability of seeing a separation at least this strong if the labels were exchangeable.',
      'Transform pipeline (Recipe): a named, ordered chain from one source recording to a previewed result. Saving the result creates a new .osmell recording.',
      'Gated Vial: a local decision pack that passed every critical validation gate. Not a safety certification, not external review.',
      'Wilson lower bound: a conservative lower bound on the paired success rate, used to avoid over-reading a small sample.',
    ],
  },
  {
    id: 'attribution',
    group: 'Reference',
    title: 'Attribution and corrections',
    summary: 'Credit is data. Corrections are a feature.',
    paragraphs: [
      'The canonical attribution and licensing record is NOTICE.md in the repository. SmellNet is MIT-licensed work from the MIT Media Lab and MIT EECS; use of the dataset does not imply MIT endorsement of Osmograph. Food Freshness and Mendeley BME688 are CC BY 4.0; keep the credit with any redistribution.',
      'If a claim in the app is stronger than its evidence, the correct fix is to weaken the claim, show the missing evidence, or remove the surface. Open an issue with the surface, the claim, and the evidence you expected. “No BS” is a testable requirement: every claim should have a source, a method, and a limit.',
    ],
    bullets: [
      'Read NOTICE.md for the canonical record.',
      'Read GUIDE.md for the long-form public guide.',
      'Report a claim that outruns its evidence; do not patch it with better copy.',
    ],
  },
];

export function guideSection(id: string): GuideSection | undefined {
  return GUIDE_SECTIONS.find(s => s.id === id);
}
