# Gesture models

WearMux includes the pretrained BrilliantWear glasses gesture model in
[`brilliantwear-glasses/`](brilliantwear-glasses/README.md). The VRU interaction
and the `sensors:ml-gesture` command load this local Edge Impulse WebAssembly
export through `sensors/lib/ml/ei-classifier.js`.

The model expects 50 acceleration samples (`x, y, z`, scaled by 1/4) at a 20 ms
interval: 150 values per one-second window. Its labels are `0_idle`, `1_nod`,
and `2_shake`. Inference runs on the WearMux host and requires no online service.
See the bundled model README for provenance, license, checksums, and metadata.

The existing `model.tflite` file and training workflows are separate from the
bundled model. Copying a custom export into this parent directory does not
replace the model selected by the classifier. When updating the bundled export,
update both JS and WASM files together and check the input contract.
