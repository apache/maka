# icy_sixel 0.5.1

Source: crates.io `icy_sixel` 0.5.1, archive SHA-256
`4bfb5a63225620b59df34a235d1fb56ff7b766909c3212a8ff927511a22b181d`.
Upstream commit: `7baecc1bbb18ddf0ff0de83d296b4509a1b64b0f` at
https://github.com/mkrueger/icy_sixel/tree/7baecc1bbb18ddf0ff0de83d296b4509a1b64b0f/crates/icy_sixel.
The MIT and Apache-2.0 licenses come from that commit's repository root.

Inventory: Cargo.toml, README.md, the four src/*.rs files, and the two license
files. Benchmark assets and image fixtures are excluded. Cargo.toml omits only
the absent external test/benchmark targets and their development dependencies;
the original embedded unit tests remain intact.

Local patch: `sixel_encode_into` sends the unchanged colour quantization and
SIXEL encoding to a fallible `std::io::Write` sink. The first output error aborts
encoding, so full terminal frames can be admitted to a bounded memory buffer
before any bytes reach the terminal. Existing string APIs delegate to that same
encoder; no palette, image dimensions, dithering or pixel data are reduced.
`SixelError::Output` preserves the original IO error. Writer output can be partial
on failure; callers must discard it rather than presenting it.

Original published-file SHA-256 inventory:

```json
{
  "Cargo.toml": "035a99fcc8bcbd3edb0f91950ca764e77d8ff0409ca7a688c515eed21c852421",
  "README.md": "8964c44e5fc7198d78b81df40757768b0e90f17e08faef60f73562ce1abf9765",
  "src/decoder.rs": "2ace4e24d1232d7e8b18d7c2e9f5df0bcb37617e169834b31359a4f41c9fb60d",
  "src/encoder.rs": "51e9cdf8b95e6802a8629a510a6d260a88102311edb8aa677c1c28786cbfd2f8",
  "src/lib.rs": "d584b8cdd0316097f48f7d91960b371bab415b9bc3641e40fb6d597268d0fb42",
  "src/sixel_image.rs": "1e968370dd0ff8c69751213a1ed11cfce6783feabb30c2b5074ac1c4ba3d8503"
}
```
