# BrilliantWear glasses gesture model

This directory vendors the precompiled Edge Impulse model used by BrilliantWear's
[glasses gestures demo](https://brilliantsole.github.io/BrilliantWear-JavaScript-SDK/examples/glasses-gestures/).
No model download, browser, training service, or build tool is needed at runtime.

## Provenance and license

Source: [`brilliantsole/BrilliantWear-JavaScript-SDK`](https://github.com/brilliantsole/BrilliantWear-JavaScript-SDK/tree/9464bb29975a07f56e12c50e82196d06b9c05a76/examples/glasses-gestures),
commit `9464bb29975a07f56e12c50e82196d06b9c05a76` (2026-07-01).
Both artifacts are unmodified and matched the hosted demo byte for byte when
retrieved on 2026-09-26. The upstream MIT license, copyright 2024 Zack Qattan,
is reproduced in [LICENSE](LICENSE).

| File | Bytes | SHA-256 |
| --- | ---: | --- |
| `edge-impulse-standalone.js` | 280242 | `30e9d60a8a0d3bc3c05b6596840f91e13b3ace8e5659feae7a3b095741f5dc1f` |
| `edge-impulse-standalone.wasm` | 7042878 | `0c809eb77dad04b8b9e761b3d5a37edc1b4a101c02fe4660ae7cbf6f963bae9d` |

## Input and output contract

The following values come from the bundled model's `getProperties()` and
`getProjectInfo()` exports:

- Project: **Brilliant Frame gestures**, owner **Zack Qattan**, ID `712496`, deployment version `1`.
- Input: **150 numbers**, representing **50 samples** of acceleration in `x, y, z` order.
- Sampling interval: **20 ms** (**50 Hz**); one window covers **1 second**.
- Scale each acceleration axis by **1/4**, matching the upstream example.
- Labels: **`0_idle`**, **`1_nod`**, **`2_shake`**.
- Classification threshold: approximately **0.6**.
- Standard window classification; continuous mode is disabled in this export.

The current upstream browser script uses 30 samples despite this model declaring
50 samples. WearMux uses the model's metadata and requires all 150 input values.
SDK sensor configuration values are intervals in milliseconds: a value of `20`
means 50 Hz. Output throttling must not drop samples before inference.

The JavaScript wrapper in `sensors/lib/ml/ei-classifier.js` supplies the local WASM
bytes before executing this generated loader, shares one initialization promise,
and releases native result objects and input allocations after inference.

The 7 MB WASM download size is not the model's live memory use: the generated
runtime initially allocates 128 MiB of linear memory. Inference runs on the
WearMux host (Mac, Raspberry Pi, etc.), not on the glasses.

## Updating

Update both artifacts from the same pinned upstream commit, retain its license,
and update the hashes above. Read the replacement model's properties before
changing sample shape, interval, scaling, or label mappings. A model smoke test
checks the bundled contract; physical gesture quality still requires a wearer.
