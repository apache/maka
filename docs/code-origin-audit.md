<!--
  Licensed to the Apache Software Foundation (ASF) under one
  or more contributor license agreements.  See the NOTICE file
  distributed with this work for additional information
  regarding copyright ownership.  The ASF licenses this file
  to you under the Apache License, Version 2.0 (the
  "License"); you may not use this file except in compliance
  with the License.  You may obtain a copy of the License at

      http://www.apache.org/licenses/LICENSE-2.0

  Unless required by applicable law or agreed to in writing,
  software distributed under the License is distributed on an
  "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
  KIND, either express or implied.  See the License for the
  specific language governing permissions and limitations
  under the License.
-->

# Source provenance

Third-party source and dependency patch attribution is recorded in [LICENSE](../LICENSE). Apply-patch adaptations have a detailed record in [plugins/workspace/workspace-files/patch/SOURCE.md](../plugins/workspace/workspace-files/patch/SOURCE.md); native Computer Use notices live in [platform/computer-use/THIRD_PARTY_NOTICES](../platform/computer-use/THIRD_PARTY_NOTICES).

### Release licensing scope

The historical incoming-code review used the individual-contributor ICLA route submitted in the [0.2.0 RC2 vote](https://lists.apache.org/thread/743v94gvldqs4pbwwg59l22pojb44v4k). The questioned contributor ICLAs were [publicly confirmed](https://lists.apache.org/thread/47jpk47vykyqr4gxy85szpq25zw0qh9f), after which Justin [withdrew his binding -1](https://lists.apache.org/thread/yno6g7kzfc9dgntt0n572zk4vnj4jr2x). The standard [DISCLAIMER](../DISCLAIMER) retains the required incubation notice without repeating the resolved ICLA concern.

This branch's source archive contains first-party Rust and TypeScript source, adapted source, pinned vendored source and the assets listed below. Vendored components preserve their own licenses and source records; a language rewrite does not remove those obligations. `scripts/asf-source-release.mjs` verifies the actual archive contents, including headers, manifest licenses and the finite non-text inventory.

Native npm packages include the root legal documents and the reviewed Rust, embedded JavaScript, V8 and Rust standard-library notices. The launcher carries the same disclaimer, and packaged macOS application resources also include the legal documents and native notices. Dependency and notice inventories are checked by `scripts/rust/dependencies.mjs` and `scripts/rust/notices.mjs`. MPL dependencies permitted for binary distribution remain external dependencies of the source archive and have license texts and exact source references in the native notices.

### Native model protocol validation

`plugins/agent/provider-protocol` implements Responses, Chat Completions compatible and Anthropic Messages with protocol-owned Rust input types, wire decoders and stream state. Chat Completions and Anthropic behavior was checked against the relevant unchanged Vercel AI SDK tests at revision `e623e8c88b55066dde769614a16ae51d424974aa` (openai-compatible 3.0.77 and anthropic 4.0.87). The upstream tests and temporary validation bindings are external validation tools and are not distributed with Maka. The product uses the same Rust protocol core through Host-scoped transport in `plugins/agent/model/src/adapters`.

### Source archive non-text inventory

- `assets/logo.png`: Product artwork reproduced by `scripts/generate-logo.py` from its vector geometry; Apache-2.0.
- `products/maka/desktop-shell/maka.ico`: Windows multi-resolution icon derived from `assets/logo.png` in [#6446](https://github.com/apache/maka/pull/6446); seven PNG images at 16–256 pixels, embedded by `windows.rc`; Apache-2.0.
- `products/maka/workbench/app/assets/maka.png`: Byte-identical copy of `assets/logo.png`, bundled with the workbench application's composer; Apache-2.0.
- `website/src/assets/incubator.png`: Unmodified Apache Incubator trademark artwork from https://www.apache.org/logos/res/incubator/default.png.
- `website/src/assets/social.en.png`: English website preview rendered by `website/scripts/social-preview.mjs`; includes the product mark and self-hosted OFL-1.1 fonts.
- `website/src/assets/social.zh-CN.png`: Chinese website preview rendered by the same source and toolchain.
- `third-party/gpui-fast/assets/fonts/ibm-plex-sans/IBMPlexSans-Regular.ttf`: Unmodified GPUI Fast font; the pinned source and SHA-256 are recorded in `third-party/gpui-fast/upstream.json`, with its SIL OFL-1.1 notice preserved in the adjacent `license.txt`.
- `third-party/gpui-fast/assets/fonts/lilex/Lilex-Regular.ttf`: Unmodified GPUI Fast font from the same source snapshot; its SIL OFL-1.1 notice is preserved in the adjacent `OFL.txt`.
- `third-party/gpui-fast/crates/gpui/examples/image/exif-orientation-rotate-180.jpg`: Unmodified GPUI image-orientation fixture from the same source snapshot, under its preserved Apache-2.0 license.
- `third-party/nsh/examples/gallery-rs/icon.png`: Unmodified NSH example application artwork; source and revision are recorded in `third-party/nsh/upstream.json`.
- `third-party/nsh/examples/gallery-rs/native/assets/bounce.gif`: Unmodified NSH gallery animation fixture from the same source snapshot.
- `third-party/nsh/examples/gallery-rs/native/assets/fonts/Pacifico-Regular.ttf`: Unmodified Pacifico example font; its SIL OFL-1.1 notice is preserved alongside it in `OFL.txt`.
- `third-party/nsh/examples/gallery-rs/native/assets/logo@2x.png`: Unmodified NSH gallery image fixture from the same source snapshot.
- `third-party/nsh/examples/gallery-rs/native/assets/spinner.webp`: Unmodified NSH gallery animation fixture from the same source snapshot.
- `third-party/nsh/examples/gallery/bounce.gif`: Unmodified NSH gallery animation fixture from the same source snapshot.
- `third-party/nsh/examples/gallery/fonts/Pacifico-Regular.ttf`: Unmodified Pacifico example font; its SIL OFL-1.1 notice is preserved alongside it in `OFL.txt`.
- `third-party/nsh/examples/gallery/icon.png`: Unmodified NSH example application artwork from the same source snapshot.
- `third-party/nsh/examples/gallery/logo@2x.png`: Unmodified NSH gallery image fixture from the same source snapshot.
- `third-party/nsh/examples/gallery/spinner.webp`: Unmodified NSH gallery animation fixture from the same source snapshot.
- `third-party/nsh/examples/terminal-workbench/assets/Pacifico-Regular.ttf`: Unmodified Pacifico example font; its SIL OFL-1.1 notice is preserved alongside it in `OFL.txt`.
- `third-party/nsh/examples/terminal-workbench/assets/runtime.png`: Unmodified NSH terminal-workbench image fixture from the same source snapshot.
- `third-party/nsh/tests/compat/cases/layout/fonts/Pacifico-Regular.ttf`: Unmodified Pacifico layout-test font; the snapshot preserves its SIL OFL-1.1 notice in `examples/gallery/fonts/OFL.txt`.
- `third-party/nsh/tests/compat/cases/props/images/flag.png`: Unmodified NSH image-scale compatibility fixture from the same source snapshot.
- `third-party/nsh/tests/compat/cases/props/images/flag@2x.png`: Unmodified NSH image-scale compatibility fixture from the same source snapshot.
- `third-party/nsh/tests/compat/cases/props/images/flag@3x.png`: Unmodified NSH image-scale compatibility fixture from the same source snapshot.
- `third-party/nsh/third-party/gpui-wgpu/test-assets/IBMPlexSans-Regular.ttf`: Unmodified GPUI WGPU test font; its SIL OFL-1.1 notice is preserved in the adjacent `IBMPlexSans-license.txt`.
- `third-party/nsh/third-party/gpui-wgpu/test-assets/Lilex-Bold.ttf`: Unmodified GPUI WGPU test font; the Lilex SIL OFL-1.1 notice is preserved in `third-party/gpui-fast/assets/fonts/lilex/OFL.txt`.
- `third-party/nsh/third-party/gpui-wgpu/test-assets/Lilex-Regular.ttf`: Unmodified GPUI WGPU test font; the Lilex SIL OFL-1.1 notice is preserved in `third-party/gpui-fast/assets/fonts/lilex/OFL.txt`.
- `third-party/nsh/website/public/apple-touch-icon.png`: Unmodified NSH website artwork from the same source snapshot.
- `third-party/nsh/website/public/icon-512.png`: Unmodified NSH website artwork from the same source snapshot.
