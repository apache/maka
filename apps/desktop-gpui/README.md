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

# Maka GPUI

An experimental desktop shell for the Maka Runtime Host, written in Rust with
[GPUI Kit](https://gpui-kit.com), in place of the Electron shell. It connects to a Runtime Host over
the Host protocol (compatibility epoch 197) and renders tasks, conversations,
tool calls, permission prompts, and settings. The Runtime, the Runtime Host,
and storage stay in TypeScript in this repository; the client owns only
presentation and desktop integration (`docs/adr/0001-thin-client-over-runtime-host-protocol.md`).

## Status

Experimental and pre-alpha. It is not part of any Maka release or binary
distribution, and no CI job in this repository builds it yet.

- macOS: runs real Turns against a local Runtime Host. Phases 1 and 2 are done;
  Phase 3 (parity with Maka Desktop's settings and sidebar pages,
  `docs/plan/phase-3-parity.md`) is in progress.
- Linux and Windows: compile, but have not been run.

`CHANGELOG.md` lists what exists and `docs/plan/` what is planned. The client
was developed in a standalone repository and imported here as one squashed
commit. The design-review screenshots and design-tool exports that some
documents under `docs/design/` and `docs/acceptance/` refer to were not
imported.

## Protocol pin

The client follows one Maka commit, not this repository's `main`. `MAKA_PIN`
names that commit (`de4fc5ff9`) and its compatibility epoch (197), and
`RUNTIME_HOST_COMPATIBILITY_EPOCH` in `crates/host-protocol` must equal it. A
Host of another epoch refuses the client, so start the Host from a separate
Maka checkout at the pinned commit (`$MAKA_REPO`, default `~/code/maka-pin`);
`docs/dev-host.md` shows how to make one. Moving the pin means updating
`MAKA_PIN`, the constant, and every protocol type that changed, together;
`just drift` checks that they agree.

## Build and run

This directory is its own Cargo workspace. It is not a member of any workspace
at the repository root, and it is not an npm workspace. Run every command from
`apps/desktop-gpui`.

Requirements:

- Rust stable 1.98 or newer. `rust-toolchain.toml` selects the toolchain and
  its components.
- [`just`](https://github.com/casey/just) for the recipes in `justfile`
  (optional; each recipe is a short Cargo or shell command).
- For a dev Host and the drift check: the Maka checkout described above, with
  its CLI built, and Node from nvm (`docs/dev-host.md`, Prerequisites).
- On Linux, GPUI's system libraries, for example on Ubuntu 24.04:
  `gcc g++ clang libfontconfig-dev libwayland-dev libxkbcommon-x11-dev libx11-xcb-dev libssl-dev libzstd-dev`.

```sh
just check      # format check, Clippy with -D warnings, tests
just drift      # compare the protocol constant, MAKA_PIN and $MAKA_REPO
just dev-host   # start a Runtime Host on the dev State Root (.dev-root)
just run        # run the app on the dev State Root
just bundle     # build target/bundle/Maka GPUI.app (macOS, release, ad-hoc signed)
```

Without `just`, `cargo check --workspace --locked` builds everything and
`cargo run -p app -- --root "$PWD/.dev-root"` runs the app. Always use a
dedicated dev State Root (`.dev-root`, ignored by Git), never your live Maka
data. `packaging/README.md` describes the macOS app bundle and what is left
before it could be distributed.

## gpui-kit pin

`gpui-kit` is pinned to the Git revision `1e41f17e27ea46589af9c6c428d18b5bf23ef4f6`
of [longbridge/gpui-kit](https://github.com/longbridge/gpui-kit) for its Diff
component, which the changes panel and the transcript's diffs use. The first
build fetches it with Git. When the next crates.io release ships (expected
2026-10-12), replace the Git line in `Cargo.toml` with that version, run
`cargo update -p gpui-kit`, and read the kit's release notes for what changed
since `1e41f17`.

## Licensing

Apache-2.0, under the repository root's `LICENSE` and `NOTICE`.
`assets/README.md` records where each bundled asset comes from. The icon set
in `assets/icons/maka/` is Maka's own, rendered by `scripts/design-icons.py`.
Rust dependencies are downloaded at build time
and are not part of the source tree; `deny.toml` holds the license policy that
`just deny` checks them against.

## Documentation

- `AGENTS.md`: engineering rules for contributors and coding agents
- `CONTRIBUTING.md`: what to check before a pull request
- `docs/plan/`: phase plans
- `docs/adr/`: architecture decisions
- `docs/dev-host.md`: running a dev Runtime Host
- `docs/design/`: design notes and review records
- `CHANGELOG.md`: what changed, by release
- `packaging/README.md`: the macOS app bundle and how a release would be cut
