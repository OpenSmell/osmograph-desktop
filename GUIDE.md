# Osmograph Field Guide

> The public mirror of the in-app **Field Guide** (`src/guide.ts`). It documents what the software does, what it refuses to do, and what would have to be true before a stronger claim is made. When the two drift, the source file is the canonical version.

Osmograph is a local-first workbench for digitising the experiment around a smell, not the smell itself. The useful claim is a closed-set, same-array comparison with the uncertainty and limits attached. It is **not** a universal smell identifier, a concentration meter, or a safety instrument.

## Contents

**Start**

- [Start here: what Osmograph is](#start)
- [Tutorials: the first 30 minutes](#tutorials)

**Methods**

- [The claim ladder](#claims)
- [Fingerprints and the difference wheel](#fingerprints)
- [How Check works](#check)
- [Recipes, trim, and replay](#recipes)

**Vials**

- [What a Vial is — and what “sealed” means](#vials)
- [Domain Vials: protocols, logs, and honest limits](#domain)
- [Authoring a domain Vial](#authoring)

**Data**

- [Data provenance and licensing](#data)
- [Privacy, storage, and control](#privacy)

**Reference**

- [Known limits (read before claiming)](#limits)
- [Glossary](#glossary)
- [Attribution and corrections](#attribution)

## Start

<a id="start"></a>

### Start here: what Osmograph is

*A local-first workbench for digitising the experiment around a smell, not the smell itself.*

Osmograph turns a gas-sensor recording into a reproducible comparison: this sample, on this array, against this reference, under this method. The core objects are Session, Recipe, Result, Experiment, Check, Vial, and Library.

It is not a universal smell identifier, a concentration meter, or a safety instrument. A sensor response is a mixture. The useful claim is a closed-set, same-array comparison with the uncertainty and limits attached.

The quickest first loop is: open Explore → tick two smells → Analyse → Compare → read the same-array guard and the difference wheel → save a Check. If you have no hardware, the bundled SmellNet recordings are enough to do the whole loop; Home → Try a comparison runs the starter pair for you.

The app is organised by job: Home, Explore, Analyse, Vials, Data, Rigs, and Settings. Hardware controls appear on Home, Rigs, and Settings; Explore, Analyse, Vials, and Data work without a rig.

- No hardware? Use Explore and Analyse → Compare. The bundled data is real and labelled.
- Have a rig? Capture a baseline and a sample on the same channels, then use Check.
- Want a reusable decision? Package a saved Check as a Vial, or install a Domain Vial for a field protocol.

<a id="tutorials"></a>

### Tutorials: the first 30 minutes

*Three short loops that produce something useful without pretending to have a lab.*

Tutorial A — read a fingerprint. Open Explore → Gallery. Pick Banana. Read the per-channel curves, the replicate spread, the channel count, and rig health. Then tick Banana and Apple, press Compare, and read the same-array guard, the per-channel overlay, and the verdict. You have just inspected a real, labelled comparison. On Home, Try a comparison runs this starter pair without hardware.

Tutorial B — save a Check. In Analyse → Check, choose a reference and a sample from the same array. Run Check. Read the lower bound and the p-value, not just the badge. Save the Check. Now open Vials → Decisions and package the saved Check. Inspect the validation gate before you trust the seal.

Tutorial C — install a Domain Vial. Open Vials → Aromatory, install Fermentation Lab, and read the risk panel before the log. Add one reading with a pH, temperature, and visual note. The point is the record, not the sensor trace. Then open Plant Respiration and read its “no ethylene channel” limit.

## Methods

<a id="claims"></a>

### The claim ladder

*Each rung needs more evidence. Never skip a rung in public language.*

The software separates four kinds of statement. They are related, but they are not interchangeable.

- Observation: “these recordings differ on this array.” Cheap, local, and easy to over-read.
- Check: “on this array, this reference and this sample are distinguishable under this method.” Adds a paired comparison, a permutation test, and a lower confidence bound.
- Sealed Vial: “this closed-set decision passed the local validation gate, with its array, limits, evidence, and method attached.” Still not a universal or cross-rig claim.
- Decision: “use this Vial for this narrow, repeated choice.” Only valid inside the declared scope and only with the declared sample preparation.

<a id="fingerprints"></a>

### Fingerprints and the difference wheel

*A fingerprint is a signed, normalised response shape — not a chemical ID or a time-series scentprint.*

Gallery cards show a compact radar: the mean settled response of each channel on the dominant array, normalised against its own baseline and drawn on one scale. It is a visual hash for scanning the library, not a chemical image.

Open a smell and the detail view shows the evidence behind that hash: one small panel per channel, thin lines for each replicate, a bold line for their mean, and relative time left to right. That is where kinetics and replicate spread become visible. It is a static summary of recordings, not a GIF or a live transformation.

The signed difference wheel is the comparison view. Positive values point outward in teal; negative values point inward in amber; a zero ring separates them. It is intentionally not a time-series plot and not a blended array.

The same-array guard is a hard rule. If the reference and sample do not share the same channel set, the comparison is refused. A six-channel SmellNet fingerprint and a user rig fingerprint are not the same object, even if both have six numbers.

- Same array only. Order and channel identity matter.
- Normalised, not absolute. The number is not ppm or concentration.
- A fingerprint is evidence of a response pattern, not a species identification.

<a id="check"></a>

### How Check works

*A baseline-relative, paired comparison with an explicit uncertainty and a permutation test.*

The current Check method is check.baseline-relative.v1, “Baseline-relative fingerprint check”, version 1.0.0. It has three steps: normalise each recording to its own baseline, compare the signed channel differences, and estimate whether the observed separation could arise by chance.

The result reports the number of held-out evaluations, a separation verdict, a 95% Wilson lower bound on the paired success rate, and a permutation p-value. A high point estimate with a wide interval is not a strong result. A p-value is not an effect size.

The verdicts are deliberately plain: separable, fragile, confusable, insufficient. “Fragile” means the comparison worked in this sample but the evidence is not strong enough for a sealed claim. “Insufficient” means there are not enough paired evaluations to say anything useful.

- Method: check.baseline-relative.v1 · version 1.0.0.
- Pairing: the reference and sample must share the same array channels.
- Statistics: paired held-out evaluations, Wilson lower bound, permutation p-value.
- Refusal: no cross-rig comparison, no absolute concentration, no chemical identification.

<a id="recipes"></a>

### Recipes, trim, and replay

*A recipe is a named transform chain, not a model and not a smell.*

Use Analyse → Recipes, or select a recording in Data → Recordings and press Trim. A recipe binds to one indexed recording, runs named transforms in order, previews the result, and can save the result as a new `.osmell` recording. The original is never overwritten. Runnable transforms include `trim.range` (cut to start/end seconds), gap fill, outlier removal, smoothing, detrending, baseline selection, response ratio, R0 normalization, and min-max/z-score scaling. Catalogued-but-unimplemented transforms are not presented as working.

Replay plays a recorded session at 0.5×–8× with a scrub bar. The live fingerprint reflects the replayed moment; replay does not feed the live detector or classifier. A saved Check is a snapshot of a verdict; reopening it recomputes against the current library.

- A recipe cannot change its source recording in place.
- Saving creates a derived recording; export it to move it.
- A derived recording is not independent evidence.

## Vials

<a id="vials"></a>

### What a Vial is — and what “sealed” means

*A Vial is a reusable, local-first decision pack, not a universal model.*

A decision Vial packages a closed-set claim with its evidence: identity and author, licence, reference and sample names, the unique array channels, at least three recordings per side, at least six held-out evaluations, the separation verdict, the 95% Wilson lower bound, the permutation p-value, explicit limits, provenance, and the method reference.

The local validation gate seals a Vial only when every critical check passes. The current gate requires a separable verdict, a lower bound of at least 55%, a permutation p-value of at most 0.05, explicit limits, source/evidence provenance, and no forbidden overclaim language. The recipe is advisory; the evidence is the gate.

“Open” does not mean broken. It means the local evidence did not clear the gate, so the Vial is labelled unusable for a decision. “Sealed” is also scoped: it is a claim about this closed set on the array that produced the evidence. It is not external validation and it does not transfer to another rig.

- Sealed is a local evidence status, not a safety certification.
- Cross-rig generalisation is explicitly refused until a calibration story exists.
- Export and import use the osmograph.vial/1 manifest as .vial.json.

<a id="domain"></a>

### Domain Vials: protocols, logs, and honest limits

*A domain Vial carries a way of working, not just a pairwise verdict. It is declarative and host-rendered.*

A domain Vial ships a protocol, a log, a risk model, decision rules, field notes, citations, and a custom workspace. The host renders the workspace from a declarative manifest; no third-party executable code runs in the app. This is the Stage 1 extension model in the design notes, not a sandboxed iframe runtime.

The official Fermentation Lab and Plant Respiration packs are examples. Fermentation Lab makes food safety the first panel and refuses to turn a pleasant smell into a safety verdict. Plant Respiration states that the current constants table has no ethylene channel and that a change signal is not a pest or pathogen diagnosis.

Anomaly Watch is the generic custom-domain pack. It documents the live anomaly engine’s contract: a per-device clean baseline, warming up, warning, critical, and emergency states, and the stop rules that keep a change signal from becoming a safety verdict. It is not a gas leak detector and it is not a safety device.

Domain Vials are where domain knowledge becomes useful: a batch log with pH, temperature, salt, and visual cues; a plant log with light, water, leaf, and root context; stop rules that tell you when to discard or inspect. The sensor stays one column in a larger record.

- Risk levels are explicit: low, medium, high, critical.
- Every domain pack must state what it is and what it is not.
- The log is stored locally and can be exported or cleared with site data.
- A domain pack can be installed from a file or from a single HTTPS manifest URL.

<a id="authoring"></a>

### Authoring a domain Vial

*A community pack is a declarative manifest you can export, version, and share — not executable code.*

Start from Vials → Aromatory → Export on an official pack, or download the starter template. Change the id, author, licence, claims, citations, and workspace content. The full schema and widget vocabulary are in AUTHORING.md.

The manifest uses schema osmograph.domain-pack/1. It must include hero, risk, docs, rig, and at least one of tracking, diagram, or rules. High and critical risk packs need a stop rule and at least three field-note sections. Citations must be real references, and whatItIsNot must name the claim you refuse to make.

Validate without launching the app with npm run validate:vial — path/to/file.vial.json. Import it in the Aromatory, or host it in your own GitHub repo and use Install from URL with the raw HTTPS URL. The local gate checks identity, licence, risk framing, docs, citations, widget shape, executable or remote UI patterns, and known overclaim language. A pass is necessary, not sufficient, for trust.

Community packs are always treated as community on import. The official.* id namespace and @opensmell handle are reserved. There is no hosted marketplace, signed registry feed, revocation service, or sandboxed code runtime. The submission unit is the .vial.json file; the public Aromatory page is a discovery list, not a trust seal.

- Data, not code: no JavaScript, custom HTML/CSS, remote images, or embedded resources.
- Use a real author, licence, citations, and an explicit whatItIsNot.
- Put the manifest in your own repo; install it from a raw HTTPS URL.
- Export, re-import, and test the rendered workspace before you share it.
- Do not claim official status, safety certification, gas leak detection, pathogen detection, diagnosis, universal smell ID, absolute concentration, or cross-rig transfer.

## Data

<a id="data"></a>

### Data provenance and licensing

*Bundled, fetched, and linked data are different. Attribution travels with the data.*

The starter library uses the public SmellNet dataset from the MIT Media Lab and MIT EECS, under the MIT licence. The public channel order is NO2, C2H5OH, VOC, CO, Alcohol, LPG; the app stores user arrays in the user order and never blends arrays. SmellNet is not bundled in full; the full release lives on Hugging Face.

Food Freshness (Zenodo) and the Mendeley BME688 dataset are CC BY 4.0. UCI datasets remain link-only because their terms conflict. The dataset catalog records the licence, credit, and download policy for each entry; the canonical attribution record is NOTICE.md.

If you import your own data, it stays local. If you download a public dataset, the app records where it came from. If a dataset is link-only, the app sends you to the source instead of silently copying it.

- SmellNet: MIT licence, MIT Media Lab + MIT EECS. No MIT endorsement of this app.
- Food Freshness and Mendeley BME688: CC BY 4.0. Keep attribution with redistributed copies.
- UCI: link-only. Do not assume redistribution rights.

<a id="privacy"></a>

### Privacy, storage, and control

*Recordings and decisions are local. You should be able to inspect, export, and delete them.*

Sessions live on disk in the app data directory. Saved checks use localStorage key osmograph.checks.v1; Vials use osmograph.vials.v1; domain-pack installs use osmograph.domain.installed.v1 and their logs use osmograph.domain.state.v1. These are local to this installation.

The desktop app does not ship product analytics. Network access happens for explicit actions such as checking for a release, downloading a public dataset, or fetching from a configured source. Those actions are visible in the UI.

Before sharing a Vial or a session, inspect it. A Vial can contain smell names, dates, usage counts, and provenance. Export is explicit; there is no silent upload.

- Local storage keys are documented so you can inspect or clear them.
- Export a Vial as .vial.json; import it on another install.
- Deleting a session removes the local recording. Deleting a Vial is a local action.

## Reference

<a id="limits"></a>

### Known limits (read before claiming)

*The refusal list is part of the product, not a disclaimer bolted on at the end.*

These limits are current engineering truths. If a future version removes one, the change needs evidence and a migration story, not a marketing sentence.

- No universal smell ID. The same molecule can smell different; the same smell can come from different mixtures.
- No absolute concentration from the current normalised fingerprints. The number is a response shape.
- No cross-rig claim without calibration. Arrays, channel order, humidity, temperature, and sensor history change the response.
- No safety verdict. Fermentation and plant packs make this explicit; a pleasant smell cannot clear a batch.
- No ethylene channel in the current constants table. Do not use the app to decide whether fruit will ripen.
- MOX sensors drift, saturate, and can be poisoned by strong VOCs. A changed sensor can look like a changed sample.

<a id="glossary"></a>

### Glossary

*Short definitions for the words the interface uses.*

Array: the set of gas-sensor channels in a recording. Channel order and identity matter.

Baseline-relative: each channel is normalised to its own opening baseline before comparison.

Check: a paired, same-array comparison with a verdict, a confidence bound, and a p-value.

Domain Vial: a declarative workspace with a protocol, log, risk model, rules, and docs.

Fingerprint: the mean settled baseline-relative response per channel on the dominant array. Gallery cards draw it as a compact radar; the detail view shows the per-channel curves and replicates.

Permutation p-value: the probability of seeing a separation at least this strong if the labels were exchangeable.

Recipe: a named, ordered transform chain from one source recording to a previewed result. Saving the result creates a new `.osmell` recording.

Sealed Vial: a local decision pack that passed every critical validation gate. Not a safety certification.

Wilson lower bound: a conservative lower bound on the paired success rate, used to avoid over-reading a small sample.

<a id="attribution"></a>

### Attribution and corrections

*Credit is data. Corrections are a feature.*

The canonical attribution and licensing record is NOTICE.md in the repository. SmellNet is MIT-licensed work from the MIT Media Lab and MIT EECS; use of the dataset does not imply MIT endorsement of Osmograph. Food Freshness and Mendeley BME688 are CC BY 4.0; keep the credit with any redistribution.

If a claim in the app is stronger than its evidence, the correct fix is to weaken the claim, show the missing evidence, or remove the surface. Open an issue with the surface, the claim, and the evidence you expected. “No BS” is a testable requirement: every claim should have a source, a method, and a limit.

- Read NOTICE.md for the canonical record.
- Read GUIDE.md for the long-form public guide.
- Report a claim that outruns its evidence; do not patch it with better copy.

## Build, author, and inspect

- [AUTHORING.md](AUTHORING.md) — the `.vial.json` schema, the policy gate, the widget vocabulary, and the submission path for community domain Vials.
- [NOTICE.md](NOTICE.md) — the canonical attribution and licensing record for datasets and bundled material.
- [README.md](README.md) — build and development instructions.

The local validation gate is not external certification. “Sealed” is a local evidence status. “Official” is a first-party label, not a safety or regulatory status. If a surface claims more than its evidence, that is a bug: open an issue with the surface, the claim, and the evidence you expected.
