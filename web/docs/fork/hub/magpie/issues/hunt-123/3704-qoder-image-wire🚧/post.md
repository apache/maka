Thanks @AlwaysBluer for the report and the serialization analysis — I checked the math and the mechanism, and this lands in the plugin, not in the gateway.

The numbers hold: 7 images at 21,096,860 Base64 characters, written twice by the Qoder adapter's `cacheMarked()` (it keeps `content` and adds `contents: m.content` on every user message — the same array in memory, serialized twice by `JSON.stringify`), then grown by the body codec's shuffled-Base64 encoding (×4/3): 21,096,860 × 2 × 4/3 ≈ 56.26 MB on the wire, past the 52,428,800-byte (50 MiB) upstream limit — with the token-based context management seeing only ~47k of 1M tokens, because the estimate counts tokens, not the wire bytes the adapter's double field and re-encoding create.

Where the fix belongs
---

- `magpie-community/plugins`, `packages/qoder/index.mjs`: `cacheMarked()` ([L861–870](https://github.com/magpie-community/plugins/blob/60b9abf2bc36046bae13854a9b07681a7d3ebaf2/packages/qoder/index.mjs#L861-L870)) adds `contents` beside `content` for block-content user messages. If the Qoder API reads only one of the two, dropping the duplicate (or serializing it as a reference, not a second copy) takes the ×2 off the image payload; if both are read, the win is smaller and the codec is the second lever.
- The body codec ([L132–158](https://github.com/magpie-community/plugins/blob/60b9abf2bc36046bae13854a9b07681a7d3ebaf2/packages/qoder/index.mjs#L132-L158)) adds 4/3 on top of the already-Base64 image data. Passing image strings through without re-encoding them into the shuffled alphabet (encoding only the shell around them) is the other half, if the endpoint accepts it.

Nothing in yetone/magpie to change: the gateway forwards the plugin's body as it is, and the 413 already fails closed with the right words (this issue's own log line points at `/compact` and smaller tool results — that part worked as built). A wire-byte-aware image estimate in the gateway would double-count against the token estimator's own accounting (#4239 has that side in flight), so I left it alone.

Not verified: no Qoder connection was made from here — the sizes above are the reporter's offline projections re-checked, not a captured outbound request; which of `content`/`contents` the Qoder API actually reads decides how much the first lever is worth.

AI use: analysis performed with AI assistance; the arithmetic and the cited plugin lines were checked locally.
