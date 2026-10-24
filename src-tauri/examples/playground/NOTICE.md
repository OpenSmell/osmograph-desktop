# Playground recording

One real recording ships with Osmograph so the app has value on a machine with
no rig attached. It is a **recording**, never a live feed: the replay surfaces
stamp it `REPLAY`, and the detector/classifier never see it.

| File | Source | Licence | Attribution |
|---|---|---|---|
| `smellnet_apple_6.csv` | SmellNet — `base_data/testing/apple/apple_6.csv` | MIT | Feng, Dai, Li, Pernigo, Wen & Liang (2026), SmellNet, MIT-MI, https://huggingface.co/datasets/DeweiFeng/SmellNet |

SmellNet is one of the three datasets the project may redistribute (MIT, with
the corpus sourced from its own repository). This file is copied verbatim from
the source; it is not modified, resampled, or relabelled.

Columns are the six array channels as recorded by the source rig
(`NO2, C2H5OH, VOC, CO, Alcohol, LPG`). The app reads them by position, so the
channel names shown in Osmograph are the rig's own labels, not a re-mapping.

Attribution line for anything derived from this file:

> SmellNet (MIT). Feng, Dai, Li, Pernigo, Wen & Liang (2026).
> https://huggingface.co/datasets/DeweiFeng/SmellNet — MIT licence.
