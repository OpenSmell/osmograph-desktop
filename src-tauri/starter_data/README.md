# Starter data

Ready-to-play smell data that ships with Osmograph so a new user can do real
work on first launch, with no hardware and no conversion step.

## `smellnet/`

12 kitchen-legible substances × 5 real replicates (60 recordings), taken from
**SmellNet**, released under the MIT licence.

- Source: https://github.com/MIT-MI/SmellNet
- Full data: https://huggingface.co/datasets/DeweiFeng/smell-net
- Citation: Feng, Dai, Li, Pernigo, Wen & Liang (2026), *SmellNet: A Large-scale
  Dataset for Real-world Smell Recognition*, ICLR 2026.
- Collected by the Multisensory Intelligence Group at the MIT Media Lab and
  MIT EECS. This attribution does not imply endorsement of Osmograph.
- Sensors in this subset: 6 gas channels — `NO2, C2H5OH, VOC, CO, Alcohol, LPG`
  — plus `Temperature, Pressure, Humidity, Gas_Resistance, Altitude` as context.
  The context columns are not treated as gas channels.
- Renamed to Osmograph's `YYYYMMDD_HHMMSS_<substance>.csv` convention so the
  importer reads the substance straight from the filename.

The full SmellNet set is 50 substances × 5 replicates plus mixtures; this is a
curated subset chosen for legibility (things a person can smell and name), not
for difficulty. The full set is not bundled and is not downloaded silently.
