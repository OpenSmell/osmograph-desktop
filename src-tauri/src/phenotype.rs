//! Live "measured phenotype" strip.
//!
//! Consumes the same validated structure as the research perception-layer:
//! the 2 device-invariant response-type clusters measured on Vergara 2012
//! (13,910 samples, 16 sensors, 10 device batches; k=2, silhouette 0.598;
//! falsification of the 4-category "strong/weak × reducing/oxidizing" scheme in
//! `interoperability/perception-layer/docs/FALSIFYING_FOUR_CATEGORY.md`).
//!
//! Honesty rules that shape this panel (mirror `percept_guidance.py`):
//!   * molecule identification is impossible (gas purity 0.405) -> never claimed;
//!   * a "strong vs weak" amplitude class is FALSIFIED -> never reported;
//!   * oxidizing categories are UNTESTED (no oxidizing data) -> never reported;
//!   * mixtures are UNTESTED -> never decomposed;
//!   * reference response-type assignment is only valid for the 16-sensor
//!     reference geometry; other rigs surface the device-invariance caveat (Q5)
//!     instead of silently applying foreign centroids.

use std::sync::{Arc, Mutex};

use serde::Serialize;

use crate::{AppState, PhaseRecorderState};

pub const DEAD_CV_MASK: f64 = 0.001;
pub const REFERENCE_CHANNELS: usize = 16;

/// Validated reference centroids (L2-normalized, Vergara 2012 A3 fingerprints)
/// from `perception-layer/results/response_type_reference.json`.
const CENTROIDS: [[f64; REFERENCE_CHANNELS]; 2] = [
    [
        0.432457, 0.550544, 0.111577, 0.112226, 0.031910, 0.029147, 0.151753, 0.158724,
        0.466186, 0.355887, 0.132521, 0.111794, 0.042907, 0.042066, 0.178100, 0.159289,
    ],
    [
        0.135263, 0.216864, 0.337475, 0.355006, 0.065734, 0.064400, 0.343353, 0.375222,
        0.128017, 0.108725, 0.317977, 0.279523, 0.089427, 0.098428, 0.338873, 0.296027,
    ],
];

/// Percep table for the validated clusters (tied to *measured membership*).
const CLUSTER_META: [(&str, &str, &str, &str); 2] = [
    (
        "small_reducing_voc",
        "Acetone/Ethanol/Acetaldehyde/Toluene",
        "reducing-VOC / solvent-like event",
        "A strongly-reducing volatile-organic event (solvent/alcohol-like).",
    ),
    (
        "basic_reducing_gases",
        "Ethylene/Ammonia",
        "basic / reducing-gas event",
        "A basic/reducing gas event (ammoniacal / alkene-like).",
    ),
];

#[derive(Serialize)]
pub struct PhenotypeReport {
    pub has_data: bool,
    pub n_channels: usize,
    pub reference_geometry: bool,
    pub per_channel: Vec<ChannelVerdict>,
    pub a1: A1Verdict,
    pub a2: A2Verdict,
    pub a3: A3Verdict,
    pub protocol: ProtocolVerdict,
    pub boundaries_cannot: Vec<String>,
    pub caveat: String,
}

#[derive(Serialize)]
pub struct ChannelVerdict {
    pub channel: usize,
    pub direction: &'static str, // "reducing" | "oxidizing" | "flat" | "masked"
    pub delta: f64,
    pub cv: f64,
}

#[derive(Serialize)]
pub struct A1Verdict {
    pub valence: &'static str, // "reducing" | "oxidizing" | "mixed" | "none" | "masked"
    pub summary: String,
}

#[derive(Serialize)]
pub struct A3Verdict {
    pub fingerprint: Vec<f64>,
    pub assignable: bool,
    pub reason: String,
    pub response_type: Option<String>,
    pub measured_membership: Option<String>,
    pub percept: Option<String>,
    pub plain_language: Option<String>,
    pub confidence: Option<String>,
    pub nearest_distance: Option<f64>,
}

#[derive(Serialize)]
pub struct A2Verdict {
    /// Rise kinetics class: fast / medium / slow / unknown. Computed from the
    /// *shape* of the live window (device-agnostic), mirroring phenotype.py.
    pub rise: String,
    /// Recovery kinetics class. Only set when a recovery (decay) phase is
    /// actually present in the window; otherwise "unknown" — never forced.
    pub recovery: String,
    /// Rise time as a fraction of the window (0→1); small = fast. Absolute
    /// seconds aren't reliable from the rolling ring, so we report the
    /// relative class instead of fabricating a seconds figure.
    pub rise_fraction: Option<f64>,
    /// True when a recovery (decay) phase was visible in this window.
    pub recovery_observed: bool,
    /// Plain-language summary for the A2 slot.
    pub summary: String,
}

#[derive(Serialize)]
pub struct ProtocolVerdict {
    pub recording: bool,
    pub current_phase: String,
    pub phase_label: String,
    pub instruction: String,
    pub complete: bool,
    pub note: String,
}

fn l2_normalize(v: &[f64]) -> Vec<f64> {
    let mut n = 0.0_f64;
    for x in v {
        n += x * x;
    }
    n = n.sqrt();
    if n < 1e-12 {
        return v.to_vec();
    }
    v.iter().map(|x| x / n).collect()
}

fn cosine_distance(a: &[f64], b: &[f64]) -> f64 {
    let mut dot = 0.0;
    for (x, y) in a.iter().zip(b.iter()) {
        dot += x * y;
    }
    let na = l2_norm(a);
    let nb = l2_norm(b);
    if na <= 0.0 || nb <= 0.0 {
        return 1.0;
    }
    let cos = (dot / (na * nb)).clamp(-1.0, 1.0);
    1.0 - cos
}

fn l2_norm(v: &[f64]) -> f64 {
    v.iter().map(|x| x * x).sum::<f64>().sqrt()
}

fn cv(values: &[f64]) -> f64 {
    if values.is_empty() {
        return 0.0;
    }
    let mean = values.iter().sum::<f64>() / values.len() as f64;
    if mean.abs() < 1e-12 {
        return 1.0;
    }
    let var = values.iter().map(|v| (v - mean).powi(2)).sum::<f64>() / values.len() as f64;
    var.sqrt() / mean.abs()
}

/// A2 — kinetic binding (rise / recovery shape), mirroring `phenotype.py`.
///
/// Computed from the *shape* of each channel's trace in the live window so it's
/// resistance-normalized and device-agnostic. Rise is always derivable when a
/// response is present; recovery ("unknown") is only reported once an actual
/// decay phase is visible — never forced, per the ontology (§3 A2) and the
/// reference `phenotype.py` recovery-unknown rule.
fn a2_kinetics(per_channel: &[ChannelVerdict], vals_by_channel: &[Vec<f64>]) -> A2Verdict {
    // Rise fraction = how far through the window the response reaches its peak.
    // A small fraction = fast surface reaction; large = slow. We classify on the
    // fastest responding (non-flat, non-masked) channel like phenotype.py does.
    let mut best_rise: Option<f64> = None; // fraction 0..1
    let mut rise_sum = 0.0;
    let mut rise_n = 0usize;
    let mut any_recovery = false;

    for (p, vals) in per_channel.iter().zip(vals_by_channel.iter()) {
        if p.direction == "flat" || p.direction == "masked" || vals.len() < 10 {
            continue;
        }
        // Locate the peak relative to the window start.
        let n = vals.len();
        let (mut peak_i, mut peak_v) = (0usize, f64::MIN);
        for (i, &v) in vals.iter().enumerate() {
            if v > peak_v {
                peak_v = v;
                peak_i = i;
            }
        }
        let peak_abs = peak_v.abs();
        if peak_abs < 1e-9 {
            continue;
        }
        // Rise completed once the signal passes 90% of its (from-start) swing.
        let start = vals[0];
        let swing = peak_v - start;
        let high = start + swing * 0.9;
        let mut rise_frac = 1.0_f64;
        for (i, &v) in vals.iter().enumerate() {
            if swing > 0.0 && (v - start) >= swing * 0.5 {
                rise_frac = i as f64 / n as f64;
                break;
            }
        }
        rise_sum += rise_frac;
        rise_n += 1;
        if best_rise.map_or(true, |b| rise_frac < b) {
            best_rise = Some(rise_frac);
        }
        // Recovery observed if the trail decays back toward the start (half-peak).
        if let Some(&tail) = vals.last() {
            if tail < peak_v - (peak_v - start).abs() * 0.15 {
                any_recovery = true;
            }
        }
    }

    if rise_n == 0 {
        return A2Verdict {
            rise: "unknown".into(),
            recovery: "unknown".into(),
            rise_fraction: None,
            recovery_observed: false,
            summary: "No responding channel — no rising response shape to classify.".into(),
        };
    }

    // Fastest responding channel drives the rise class (phenotype.py: min rise).
    let rise_frac = best_rise.unwrap_or(rise_sum / rise_n as f64);
    let rise_class = if rise_frac < 0.30 {
        "fast"
    } else if rise_frac < 0.65 {
        "medium"
    } else {
        "slow"
    };

    let recovery_class = if any_recovery { "observed" } else { "unknown" };
    let summary = format!(
        "live rise kinetics: {} ({}% of window to peak) · recovery: {}",
        rise_class,
        (rise_frac * 100.0).round() as i64,
        if any_recovery { "observed" } else { "unknown — no recovery phase yet" }
    );

    A2Verdict {
        rise: rise_class.into(),
        recovery: recovery_class.into(),
        rise_fraction: Some(rise_frac),
        recovery_observed: any_recovery,
        summary,
    }
}

/// Assemble the live measured-phenotype report from the current readings ring.
pub fn compute_phenotype_report(
    readings: &Arc<Mutex<Vec<Vec<f64>>>>,
    channel_count: &Arc<Mutex<usize>>,
    phase: &crate::PhaseRecorderState,
) -> Result<PhenotypeReport, String> {
    let buf = readings.lock().map_err(|e| e.to_string())?;
    let n_channels = *channel_count.lock().map_err(|e| e.to_string())?;

    // Baseline = first ~20% of the window; signal = trailing ~20%.
    let total = buf.len();
    if total < 40 {
        return Ok(PhenotypeReport {
            has_data: false,
            n_channels,
            reference_geometry: n_channels == REFERENCE_CHANNELS,
            per_channel: Vec::new(),
            a1: A1Verdict {
                valence: "none",
                summary: "Waiting for enough samples to form a phenotype baseline…".into(),
            },
            a2: A2Verdict {
                rise: "unknown".into(),
                recovery: "unknown".into(),
                rise_fraction: None,
                recovery_observed: false,
                summary: "Waiting for enough samples to estimate the response shape…".into(),
            },
            a3: A3Verdict {
                fingerprint: Vec::new(),
                assignable: false,
                reason: "insufficient_data".into(),
                response_type: None,
                measured_membership: None,
                percept: None,
                plain_language: None,
                confidence: None,
                nearest_distance: None,
            },
            protocol: protocol_verdict(phase),
            boundaries_cannot: boundaries_cannot(),
            caveat: CAVEAT_REFERENCE.into(),
        });
    }

    let base_n = (total / 5).clamp(5, 60);
    let sig_n = (total / 5).clamp(5, 60);

    let mut per_channel = Vec::new();
    let mut vals_by_channel: Vec<Vec<f64>> = Vec::new();
    let mut fingerprint = vec![0.0_f64; n_channels];
    let mut active_vals: Vec<f64> = Vec::new();

    for ch in 0..n_channels {
        let vals: Vec<f64> = buf.iter().filter_map(|r| r.get(ch)).copied().collect();
        if vals.len() < 10 {
            vals_by_channel.push(vals);
            per_channel.push(ChannelVerdict {
                channel: ch,
                direction: "flat",
                delta: 0.0,
                cv: 0.0,
            });
            continue;
        }
        let c = cv(&vals);
        if c < DEAD_CV_MASK {
            vals_by_channel.push(vals);
            per_channel.push(ChannelVerdict {
                channel: ch,
                direction: "masked",
                delta: 0.0,
                cv: c,
            });
            continue;
        }
        let base: f64 = vals[..base_n.min(vals.len())].iter().sum::<f64>()
            / base_n.min(vals.len()) as f64;
        let sig: f64 = vals[vals.len() - sig_n.min(vals.len())..].iter().sum::<f64>()
            / sig_n.min(vals.len()) as f64;
        let denom = base.abs().max(1e-9);
        let delta = (sig - base) / denom;
        let dir = if delta < -0.02 {
            "reducing"
        } else if delta > 0.02 {
            "oxidizing"
        } else {
            "flat"
        };
        fingerprint[ch] = delta.abs().max(0.0);
        if dir != "flat" && dir != "masked" {
            active_vals.push(if delta < 0.0 { -delta } else { delta });
        }
        per_channel.push(ChannelVerdict {
            channel: ch,
            direction: dir,
            delta,
            cv: c,
        });
        vals_by_channel.push(vals);
    }

    // A2 — live kinetic binding from the window shape (phenotype.py parity).
    let a2 = a2_kinetics(&per_channel, &vals_by_channel);

    // A1 aggregate (direction of the majority of unmasked, responding channels).
    let mut reducing = 0;
    let mut oxidizing = 0;
    let mut responding = 0;
    for p in &per_channel {
        match p.direction {
            "reducing" => {
                reducing += 1;
                responding += 1;
            }
            "oxidizing" => {
                oxidizing += 1;
                responding += 1;
            }
            _ => {}
        }
    }
    let a1 = if responding == 0 {
        A1Verdict {
            valence: "none",
            summary: "No channel shows a directional response in this window.".into(),
        }
    } else if reducing == responding {
        A1Verdict {
            valence: "reducing",
            summary: format!(
                "{}/{} channels deflected reducing-side (n-type MOX: R↓ on reducing exposure).",
                reducing, responding
            ),
        }
    } else if oxidizing == responding {
        A1Verdict {
            valence: "oxidizing",
            summary: format!(
                "{}/{} channels deflected oxidizing-side (rising resistance). Oxidizing targets are UNTESTED by the reference data.",
                oxidizing, responding
            ),
        }
    } else {
        A1Verdict {
            valence: "mixed",
            summary: format!(
                "Mixed deflection — {reducing} reducing / {oxidizing} oxidizing. The reference data only supports direction-organized reducing events.",
                reducing = reducing,
                oxidizing = oxidizing
            ),
        }
    };

    // A3 selectivity profile -> nearest validated cluster.
    let fp = l2_normalize(&fingerprint);
    let (assignable, reason);
    if n_channels == REFERENCE_CHANNELS {
        assignable = fingerprint.iter().any(|&v| v > 0.0);
        reason = if assignable {
            "reference_geometry".into()
        } else {
            "flat_selectivity_profile".into()
        };
    } else {
        assignable = false;
        reason = "reference_space_mismatch".into();
    }

    let (mut response_type, mut membership, mut percept, mut plain, mut confidence, mut nearest) =
        (None, None, None, None, None, None);
    if assignable {
        let mut best = 0usize;
        let mut best_d = f64::MAX;
        let mut second = f64::MAX;
        for (c, centroid) in CENTROIDS.iter().enumerate() {
            let d = cosine_distance(&fp, centroid);
            if d < best_d {
                second = best_d;
                best_d = d;
                best = c;
            } else if d < second {
                second = d;
            }
        }
        let margin = second - best_d;
        let conf = if best_d < 0.3 && margin > 0.2 {
            "high"
        } else if best_d < 0.5 {
            "medium"
        } else {
            "low"
        };
        let (id, mem, perf, plain_lang) = CLUSTER_META[best];
        response_type = Some(id.to_string());
        membership = Some(mem.to_string());
        percept = Some(perf.to_string());
        plain = Some(plain_lang.to_string());
        confidence = Some(conf.to_string());
        nearest = Some(best_d);
    }

    Ok(PhenotypeReport {
        has_data: true,
        n_channels,
        reference_geometry: n_channels == REFERENCE_CHANNELS,
        per_channel,
        a1,
        a2,
        a3: A3Verdict {
            fingerprint: fp,
            assignable,
            reason,
            response_type,
            measured_membership: membership,
            percept,
            plain_language: plain,
            confidence,
            nearest_distance: nearest,
        },
        protocol: protocol_verdict(phase),
        boundaries_cannot: boundaries_cannot(),
        caveat: if n_channels == REFERENCE_CHANNELS {
            CAVEAT_RETENTION.replace("{n}", &n_channels.to_string())
        } else {
            format!(
                "This rig streams {} channels; the validated response-type space is the 16-sensor reference array. Device-invariance across array types is an open question (perception-layer Q5) — response-type is not assigned for this geometry.",
                n_channels
            )
        },
    })
}

const CAVEAT_REFERENCE: &str =
    "Measured phenotype is windowed: baseline vs trailing response. Reference response-types are for the 16-sensor array geometry.";

const CAVEAT_RETENTION: &str =
    "Reference geometry recognised ({n} channels): assignment uses the validated 2-cluster reference. Across-array device invariance remains an open question (Q5).";

fn protocol_verdict(phase: &crate::PhaseRecorderState) -> ProtocolVerdict {
    let complete = !phase.phases.is_empty()
        && phase.phases.iter().filter(|p| p.sample_count > 0).count() == 3;
    ProtocolVerdict {
        recording: phase.active,
        current_phase: phase.current_phase.clone(),
        phase_label: phase.current_phase_label.clone(),
        instruction: phase.current_phase_instruction.clone(),
        complete,
        note: if phase.active {
            "Protocol recording in progress — kinetics (A2) axes become valid once a full baseline → exposure → recovery recording completes.".into()
        } else if complete {
            "A complete baseline → exposure → recovery recording exists; A2 kinetics can be quantified on that session.".into()
        } else {
            "No complete protocol recording yet — A2 kinetics axes are not reportable for a bare live stream.".into()
        },
    }
}

fn boundaries_cannot() -> Vec<String> {
    vec![
        "absolute_ppm/concentration".into(),
        "exact_molecule_identification".into(),
        "oxidizing_category (untested)".into(),
        "mixture_decomposition (untested)".into(),
        "strong_vs_weak_amplitude_class (falsified)".into(),
    ]
}

/// Build an idle PhaseRecorderState snapshot from the recorder slot (no advance).
fn phase_snapshot(state: &AppState) -> PhaseRecorderState {
    let slot = state.phase_recorder.lock().unwrap_or_else(|_| {
        // A poisoned slot cannot be produced by normal use; treat as idle.
        unreachable!("phase recorder slot poisoned")
    });
    match slot.as_ref() {
        Some(rec) => crate::phase_recorder_state(rec),
        None => PhaseRecorderState {
            active: false,
            label: String::new(),
            current_phase: String::new(),
            current_phase_label: String::new(),
            current_phase_color: String::new(),
            current_phase_instruction: String::new(),
            phase_elapsed: 0.0,
            phase_duration: 0.0,
            phase_progress: 0.0,
            total_elapsed: 0.0,
            total_duration: 0.0,
            total_progress: 0.0,
            phases: Vec::new(),
            saved_path: None,
        },
    }
}

/// Tauri command: assemble the live measured-phenotype report.
#[tauri::command]
pub fn compute_phenotype(
    state: tauri::State<'_, AppState>,
) -> Result<PhenotypeReport, String> {
    let phase = phase_snapshot(&state);
    compute_phenotype_report(&state.current_readings, &state.channel_count, &phase)
}