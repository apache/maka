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

# AGENTS.md

Rules for every change under `apps/desktop-gpui`, by people or coding agents,
in addition to the repository root's `CONTRIBUTING.md`. "Must" and "never"
are requirements.

## Purpose

Maka GPUI is a native desktop client for the Maka Runtime Host, written in Rust
with GPUI through the `gpui-kit` crate. It is a thin client: it speaks the
Runtime Host protocol (one JSON object per line over a Unix domain socket or a
Windows named pipe; WebSocket later) and owns only presentation and desktop
integration. The Runtime, the Runtime Host, storage, and the CLI stay in
TypeScript in the rest of this repository. Scripts and docs locate the
local Maka checkout through the `MAKA_REPO` environment variable, default
`~/code/maka-pin`: a checkout of the apache/maka commit `MAKA_PIN` names, the
protocol this client speaks. Never port Host logic into this client. The decision
is recorded in `docs/adr/0001-thin-client-over-runtime-host-protocol.md`; the
phase plan is in `docs/plan/`.

## Layout and dependency direction

```text
crates/
├── app/            shell: main, windows, menus, the workbar's strip; composes feature crates
├── host-protocol/  wire types and frame codec; no GPUI, no I/O
├── host-client/    transport, handshake, request multiplexing, subscriptions,
│                   reconnect, Host spawn
├── shared/         theme tokens, stable ElementId derivation, copy (i18n), time formatting
├── workspace/      project selection, State Root management, Host connection state
├── session/        session catalog, creation, switching, metadata
├── transcript-model/ pure logic: subscription frames -> transcript state; no GPUI
├── conversation/   transcript, streaming output, tool calls, permission prompts, composer
├── review/         the task's Git changes, read on this machine, and the workbar's
│                   Changes face
├── search/         finding text: the Searchable seam, matching, the find bar, and the
│                   Search page over every task
├── terminal/       a task's terminals: Host-owned PTYs driven through runtime resources,
│                   the emulator their output is parsed into, key and mouse tables, and
│                   the terminal view (the workbar's Terminal face) that paints them
├── files/          a task's artifacts read from the Host: the workbar's Files face,
│                   its list, previews and actions
├── inspector/      a task's trace, usage and context window read from the Host: the
│                   workbar's Trace face (Desktop's Inspector)
└── settings/       model connections, preferences
docs/
├── plan/           phase plans
├── adr/            architecture decisions
└── *.md            design notes with source references, not user documentation
scripts/            protocol drift check, fixture capture
```

- Dependencies point down only: `app -> feature crates -> shared, host-client -> host-protocol`.
  No cycles.
- A feature crate never depends on `app` or on another feature crate's views.
  Features communicate through an explicit command, event, data type, or small
  shared service.
- `host-protocol` has no GPUI, no I/O, and no async runtime.
- `transcript-model` has no GPUI. It is tested by replaying recorded frame
  sequences from a real Host and asserting the resulting state.
- `host-client` has no views. It uses smol-family async I/O (`async-io`,
  `async-net`) so it runs on GPUI's executor. Never add tokio or a second
  async runtime.
- Create a crate when its phase needs it. Do not scaffold empty crates.
- The version lives only in the workspace `Cargo.toml`.

## gpui-kit rules

The skill files are the source of truth. They are published in the `skills/`
directory of `longbridge/gpui-kit` (use the revision `Cargo.toml` pins) and are
not copied into this repository. Read them before any UI work:

- `skills/gpui-kit/SKILL.md`
- `skills/gpui-kit/references/coding-guides.md`
- `skills/gpui-kit-design-guides/SKILL.md` and its `references/design-guides.md`
  before changing anything visible

The rules below are a floor. Where they differ from the skill files, the skill
files win.

- Never invent an API. Grep the gpui-kit source in `~/.cargo/registry/src/`
  (`gpui-kit-*`, `gpui-component-*`, `gpui-base-*`, `gpui-*`) for the real
  signature. Do not translate React, CSS, or older GPUI examples by analogy.
- Depend on `gpui-kit` alone. GPUI is `use gpui_kit::*;`; the layers are
  `gpui_kit::component`, `gpui_kit::base`, `gpui_kit::assets`, `gpui_kit::platform`.
- Call `gpui_kit::init(cx)` once, before creating any component-backed view.
  Put `Root` at the top of each window, one per window.
- Choose `RenderOnce` or `Entity<T>` deliberately. Split state into entities by
  coherent ownership, not one entity for the whole app.
- Never retain `&mut Window`, `&mut App`, or `&mut Context<_>` past the call.
  Retain `Entity`, `WeakEntity`, `FocusHandle`, scroll handles, or domain IDs.
- Repeated elements get an `ElementId` derived from a domain ID (session ID,
  `toolCallId`), never from a list index or a random value.
- Use theme tokens (`cx.theme()`) and component sizes, not literal colors,
  radii, or sizes.
- Use the semantic component (`Button`, menus, lists) instead of a clickable
  `div`. The component supplies focus, keyboard, and disabled behavior.
- Model one command once as an Action or owner method. Toolbar, menu, context
  menu, and key binding dispatch the same thing. Call `cx.bind_keys` before
  `cx.set_menus`.
- No `pub` fields across a crate seam, except record-like types marked
  `#[non_exhaustive]`. Use builders and readers.
- `cx` is GPUI's context. Name anything else after what it holds.
- Never mutate state, notify, or request focus unconditionally in `render`.
  Never rebuild entities, subscriptions, or focus handles per frame.
- Represent async operations with explicit states (idle, loading, loaded,
  failed). Keep previous data visible during refresh. Block duplicate
  destructive submissions. Show recoverable errors in the UI, not only in logs.
- Give nested scroll containers an explicit owner.
- Do not add a confirmation dialog for a reversible, low-risk action.
- Do not add a component variant for a one-off screen.

For each change, be able to name: the behavior owner and presentation owner;
the retained identity and state lifecycle; the pointer, keyboard, and focus
contract; the layout and overflow owner; the theme tokens and any intentional
exception; the test that would fail if the behavior regressed.

Before review, run the "Implementation checklist" in `coding-guides.md`
against the change.

## Performance rules

Performance is a product requirement.

- Nothing reachable from `render` may do I/O, spawn or wait on a subprocess,
  walk the filesystem, touch the network, take a blocking lock, or make a
  synchronous IPC call. This covers helpers called from `render` and closures
  that run during layout, prepaint, or paint.
- Start background work from an event, lifecycle hook, or named method. Run it
  with `cx.background_spawn`, store the result on the owning entity, and call
  `cx.notify()` once per coherent change.
- Resolve a whole collection (for example, metadata for every session in the
  catalog) in one background pass, not per row. Guard it with a generation
  counter: increment before starting, and drop any result whose generation is
  no longer current.
- A handler for a one-shot user action may do short synchronous work. Code
  that runs every frame may not.
- Long collections (transcripts, session lists, tool output) use a
  virtualized list or table. Keep row identity separate from visible position.
- Rate limits: streaming text commits at most about 8 Hz (coalesce deltas);
  spinners at most 60 Hz; any other periodic update (elapsed time, progress,
  pulses) at most 30 Hz.
- `clippy.toml` bans `std::thread::sleep`, `std::fs::{read, read_to_string,
  write, read_dir}`, and `std::process::Command::{output, status}`. A scoped
  `#[allow(clippy::disallowed_methods)]` with a one-line reason is allowed
  only in tests, examples, build scripts, and code that provably runs on a
  background thread.
- Measure before adding a cache. Every cache has one named invalidation owner.

## Accessibility rules

Accessibility is a product requirement. GPUI exposes no screen-reader tree, so
keyboard access and visual clarity must carry the whole load.

- Every control reachable by mouse is reachable by keyboard. Retain a
  `FocusHandle` in the owning entity. A tracked handle is a Tab stop only when
  built with `cx.focus_handle().tab_stop(true)` (or `.tab_index(n)`).
- Every focusable element shows a visible focus state (`focus_visible`).
- Use conventional keys: arrows move within lists, menus, and tabs; Home and
  End jump to the ends; Enter activates or submits; Space toggles or
  activates; Escape closes the topmost overlay or cancels. Escape never
  answers a permission prompt with "deny".
- Honor the system reduce-motion preference. State must be understandable
  without animation.
- Never encode meaning in color, hover, or motion alone. Pair it with text, an
  icon, or shape.
- Content revealed on hover (row actions, informational tooltips) is also
  reachable through focus.
- Keep hit areas larger than the glyph. Use component sizes rather than bare
  icons.

## Protocol discipline

- Every serde type traces to a TypeScript decoder in the Maka repository. Cite
  the path and symbol in its doc comment, for example
  ``/// Mirrors `decodeSessionStatus` in packages/runtime-host/src/protocol/session-status.ts.``
- Keep wire names with `#[serde(rename_all = "camelCase")]`.
- Production types tolerate unknown fields. `#[serde(deny_unknown_fields)]` is
  allowed only on test-only fixture types.
- `MAKA_PIN` names the apache/maka commit this client follows and its
  compatibility epoch. `RUNTIME_HOST_COMPATIBILITY_EPOCH` in
  `crates/host-protocol` mirrors the constant in
  `$MAKA_REPO/packages/runtime-host/src/protocol/index.ts` at that commit.
  `just drift` (`scripts/check-protocol-drift.sh`) fails unless the Rust
  constant, the pin, and the checkout's commit and epoch agree; CI checks out
  the pinned commit and runs it. When the epoch changes, update the pin, the
  constant, and every affected type in the same change.
- Golden fixtures come from a real Host through the capture script
  (`just fixtures`). Regenerate them instead of editing by hand.
- Development always uses a dedicated dev State Root. Never connect to, spawn
  against, or write into the user's live Maka data. See `docs/dev-host.md`.

## Verification

- "Compiles" is not done.
- `just check` (format check, Clippy with `-D warnings`, tests) must be green
  before review.
- Validate UI changes in the running app (`just run`) against a real dev Host,
  including the keyboard path. Report automated and manual evidence
  separately.
- Cover UI behavior with `#[gpui_kit::test]` integration tests where feasible.
  Test at the lowest layer that proves the behavior. For a reproducible bug,
  add the failing test before the fix.
- Protocol changes need fixture round-trip tests and a passing `just drift`.

## Licensing

- This client is Apache-2.0, like the rest of the repository. New dependencies
  must pass `just deny`.
- egoist/waku is GPL-3.0. Read it for practices only. Never copy or translate
  its code.
- Most Zed application crates are GPL-3.0 or AGPL-3.0. Check a crate's license
  before reusing any of its code.

## Commits and pull requests

Follow the repository root's `CONTRIBUTING.md`: Conventional Commits titles
(scope `desktop-gpui`), a body that explains why the change is needed, and its
rules for disclosing generative tooling.
