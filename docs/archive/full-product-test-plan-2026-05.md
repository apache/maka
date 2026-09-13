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

# Maka full product completion and test plan

> Archived on 2026-07-13. This one-month delivery plan is retained as historical context; current work and progress belong in GitHub issues and pull requests.

> Owner: @xuan
> Date: 2026-05-22
> Scope: one-month completion plan for Maka desktop product capability, quality gates, and release testing.

This document is a delivery contract. A feature is not done because UI exists or a PR merged. It is done only when the user flow, data contract, tests, fixtures, smoke path, and security/privacy gates are all present.

## 0. Non-negotiable Rules

Every PR must answer these five questions in its description:

1. **Contract**: What data structure, IPC channel, runtime event, persisted state, or component contract changed?
2. **User Flow**: What exact path can the user complete after this PR?
3. **Tests**: Which unit, storage, runtime, IPC/main, renderer-helper, fixture, and smoke tests cover it?
4. **Security**: What trust boundary, secret handling, path guard, sandbox, redaction, or permission rule applies?
5. **Not Included**: What adjacent work is explicitly out of scope and tracked separately?

No release if any of these are true:

- A configured ready default model exists but old sessions can still block sending.
- A provider key, raw provider error, filesystem absolute path, chatId, or secret-shaped value can leak to stdout, UI, telemetry, export, diagnostics, or artifact metadata.
- Renderer can read or open arbitrary absolute paths.
- HTML/Markdown content can navigate the Electron renderer, open a Node-enabled window, or escape its sandbox.
- A new UI surface has no empty, loading, error, and focus state.
- A new stateful feature has no deterministic fixture scenario and no smoke path.
- A new logic branch exists only in React code without a pure helper or automated test when a pure helper is practical.
- A manual-only gate is used for a case that can be deterministically tested with node:test.

## 1. One-Month Delivery Plan

### Week 1: restore trust and complete Artifact Workbench

Goal: core chat send path and generated work output must be reliable.

Required deliverables:

- P0 stale-session send/rebind fully closed.
- Artifact pane becomes a real workbench surface, not a transcript ornament.
- Real save/export behavior for artifacts.
- Artifact runtime hooks cover common file-producing tools.
- Deterministic fixture and smoke coverage for normal, error, deleted, too-large, unsupported MIME, and reload states.

Done means:

- Old `fake`, legacy backend, deleted connection, stale model, and valid Z.ai default cases are all tested.
- Artifact records are file-backed, renderer never sees absolute paths, deleted tombstones block reads, symlink escapes fail.
- HTML previews are view-only with sandbox and blocked navigation.
- Binary previews use sniffed MIME allowlist.
- Smoke paths cover light, dark, narrow, reload, and failure states.

### Week 2: model catalog, workstation shell, session status, turn controls

Goal: Maka stops behaving like a generic chat list and starts behaving like a workbench with explicit state.

Required deliverables:

- `ModelCatalogEntry` with normalized capabilities, source, stale/unsupported reason, context, and pricing fields.
- Chat default cannot be image-only, embedding-only, unsupported, disabled, missing, or stale without a visible reason.
- Session status model: active, running, waiting, blocked, review, done, archived, stale, errored.
- Sidebar/header expose workspace, model, status, blocked reason, and old-session migration state.
- Turn controls: retry, regenerate, branch-from-turn, cancel, checkpoint-before-tools.

Done means:

- Status transitions have node:test coverage.
- Turn controls cannot overwrite old output.
- Cancel persists an explicit aborted state.
- Unsupported model cases are visible in ModelTable and fail closed in send readiness.
- Fixture scenarios seed each status and model capability combination.

### Week 3: Health Center, First-run, Quick Chat, Settings completion

Goal: setup, debugging, and entry points are first-class.

Required deliverables:

- Health Center for provider, credential, bot, proxy, search, voice, open-gateway, storage, artifact, and workspace health.
- Redacted diagnostics copy.
- First-run stepper: provider preset, paste key, test/fetch models, choose default, send smoke prompt.
- Quick Chat MVP: global shortcut and panel window; no accessibility-tree capture in MVP unless separately approved and gated.
- Settings panels for font/sidebar, chat tuning, editable keybindings, and advanced flags.

Done means:

- First-run does not allow fallback-as-success.
- Health Center uses generalized reasons and never raw provider errors.
- Quick Chat opens fast, focuses composer, reuses readiness guard, and fails closed when no ready model exists.
- Keybindings detect collisions and have reset defaults.

### Week 4: Open Gateway, Memory, Voice, Search, MCP, Sources/Skills/Automations

Goal: complete the promised ecosystem and automation surfaces without widening permissions invisibly.

Required deliverables:

- OpenAI-compatible local gateway with auth, SSE, model mapping, usage telemetry, and shutdown.
- Memory MVP with explicit inspect/delete controls and no hidden permission widening.
- Voice input MVP with permission state and transcript correction.
- Search/web citation surface with source chips and export behavior.
- MCP servers panel with status, scopes, tool list, and disable controls.
- Sources, Skills, Automations view: auth/scope, allowed tools, last run, last error, and disable.

Done means:

- Each external integration has auth, missing, timeout, network, rate limit, and revoked states.
- Each automation is visible, disable-able, and auditable.
- Skill installation never implies permission widening.
- Diagnostics and telemetry are redacted and reason-coded.

## 2. Testing Layers

### 2.1 Core unit tests

Use for:

- data contracts and enum validation,
- permission categorization,
- redaction and generalized error messages,
- model capability/readiness rules,
- session/turn status transitions.

Gate:

```bash
npm --workspace @maka/core test
```

### 2.2 Storage tests

Use for:

- JSONL header migration,
- artifact metadata and file-backed payloads,
- credential/connection persistence,
- telemetry aggregation,
- symlink and traversal path guards,
- tombstones and purge behavior.

Gate:

```bash
npm --workspace @maka/storage test
```

### 2.3 Runtime tests

Use for:

- SessionManager lifecycle,
- backend rebuild on config changes,
- streaming events,
- tool artifact derivation,
- cancellation,
- permission parking,
- provider model fetch and connection testing.

Gate:

```bash
npm --workspace @maka/runtime test
```

### 2.4 Desktop main / IPC tests

Use for:

- chat readiness and auto-rebind,
- external link guard,
- window state,
- open path guard,
- visual smoke fixture mode,
- connection status,
- settings IPC helpers,
- artifact IPC failure reasons,
- sandbox bridge sanity.

Gate:

```bash
npm --workspace @maka/desktop test
```

### 2.5 Renderer pure-helper tests

Use for:

- state derivation,
- keyboard transition helpers,
- display copy matrices,
- status priority,
- turn materialization,
- command palette filtering,
- sidebar stale/session status projection.

Rule: if a React branch decides behavior from data, extract it to a pure helper unless the branch is trivial.

### 2.6 Fixture scenarios

Each new surface gets a deterministic fixture. Fixtures must:

- run only in dev/test,
- use isolated `workspaces/visual-smoke-*`,
- seed from scratch on launch,
- not depend on real keys or network,
- expose transient state only through `visualSmoke.getState()`,
- return `null` when fixture mode is off.

Required scenarios:

| Scenario | Purpose |
|---|---|
| `first-run` | empty workspace, no connection |
| `provider-workspace` | fetched models, default, verified |
| `provider-fallback` | fallback source and refresh error |
| `provider-empty` | fetched-empty state |
| `connection-error` | needs_reauth/error header |
| `turn-narrative` | user, tools, assistant, token summary, thinking |
| `streaming-sidebar` | streaming preview and unread priority |
| `permission-destructive` | destructive PermissionDialog |
| `artifact-pane` | html, diff, markdown/file artifacts |
| `artifact-errors` | deleted, too_large, unsupported_mime, missing |
| `stale-sessions` | fake/stale/deleted session rows and header badges |
| `workstation-statuses` | active/running/waiting/blocked/review/done/archive |
| `turn-controls` | retry/regenerate/branch/cancel/checkpoint |
| `model-catalog` | chat/image/embedding/unsupported/stale models |
| `health-center` | all healthy + all errors |
| `first-run-stepper` | happy path + test/fetch failure |
| `quick-chat` | panel open, no-ready default, ready default |
| `sources-skills-automations` | source auth/scope, skill tools, automation last run |

### 2.7 Smoke paths

`apps/desktop/tests/smoke.md` is the release checklist. Every fixture scenario above needs a smoke path or an explicit reason it is covered by an existing path.

Each smoke path must include:

- launch command,
- fixture scenario,
- exact user steps,
- expected UI state,
- failure state,
- light/dark/narrow screenshot requirement,
- reload persistence expectation,
- no-go regressions.

### 2.8 Visual regression

Required screenshots for each new surface:

- light desktop,
- dark desktop,
- narrow width,
- loading,
- empty,
- error/failure,
- active/focus state.

Current automation:

- `npm --workspace @maka/desktop run screenshots` captures all fixture
  scenarios across light/dark, 1280/990 width, normal/reduced motion.
- `npm --workspace @maka/desktop run screenshots:diff:stable` is the
  blocking sanity gate for the stable subset (`artifact-pane`,
  `first-run`, `artifact-errors`).
- The stable gate fails only for capture/pipeline/viewport failures:
  missing PNGs, corrupt PNGs, too-small/truncated PNGs, and wrong
  dimensions.
- Byte-size drift is a warning, not a blocker.

Explicit limitation: the current PR-IR-02 gate is **not** a pixel-level
visual regression test. It does not prove UI layout, color, typography,
spacing, or focus rendering stayed correct. Reviewers must still inspect
the screenshots for visual quality and use the smoke paths for behavior.

Future automation target:

- pilot pixel-level diff only on the stable subset first,
- use calibrated tolerance instead of byte/SHA equality,
- support ignored dynamic regions for timestamps/streaming/transient UI,
- save diff artifacts for review,
- expand beyond the stable subset only after the gate is quiet on main.

### 2.9 Security and privacy gates

Every feature must declare:

- path boundary,
- network boundary,
- secret boundary,
- renderer/main trust boundary,
- export/clipboard boundary,
- telemetry/log boundary,
- permission boundary.

Required checks:

- `scripts/check-console.mjs` passes.
- new `console.*` is dev-only or allow-listed with reason.
- user/provider text in export/diagnostics is redacted.
- raw provider errors go through `generalizedErrorMessage`.
- renderer never receives decrypted secrets.
- absolute paths are not shown unless the surface is explicitly a local-path management surface.
- file operations use realpath containment, not string prefix checks.
- Electron navigation/window-open remains blocked for untrusted content.

## 3. Feature Done Definitions

### 3.1 Chat send and session readiness

Cases:

- no default connection,
- default points to `fake`,
- missing connection,
- disabled connection,
- missing API key,
- missing model,
- empty model list,
- model not enabled,
- stale fake session with ready default,
- stale missing connection with ready default,
- stale session without ready default,
- active backend cache after rebind.

Done means:

- ready default + stale old session sends successfully after auto-rebind,
- no ready default fails with original machine-readable reason,
- renderer keeps unsent input when send fails,
- header/sidebar explain stale state before send,
- tests cover all cases.

### 3.2 Artifact Workbench

Cases:

- list/get/read text/read binary/delete,
- live artifact creation from tool output,
- deleted tombstone blocks read,
- symlink escape,
- traversal path,
- too large text,
- unsupported MIME,
- HTML with external links,
- reload persistence,
- reveal in Finder,
- real Save As.

Done means:

- artifact is a first-class object,
- transcript references are compact,
- pane previews are reliable,
- export/save works without exposing renderer to absolute paths.

### 3.3 Model Catalog

Cases:

- fetched source,
- fallback source,
- fetched-empty,
- stale cache,
- unsupported image-only,
- unsupported embedding-only,
- missing tool-use in execute mode,
- custom OpenAI-compatible,
- pricing override.

Done means:

- UI displays facts from backend-normalized catalog,
- chat readiness rejects unsupported defaults,
- model table explains disabled rows.

### 3.4 Workstation Shell

Cases:

- active,
- running,
- waiting permission,
- blocked by config/auth,
- review,
- done,
- archived,
- stale/rebound,
- error.

Done means:

- sidebar, header, and chat body agree on status,
- status changes are persisted,
- status transitions are tested,
- no status is inferred only by styling.

### 3.5 Turn Controls

Cases:

- retry failed turn,
- regenerate assistant answer,
- branch from a prior turn,
- cancel running turn,
- checkpoint before tools,
- old output preserved.

Done means:

- persisted turn state prevents overwrite,
- branch copies the right message boundary,
- cancel writes aborted,
- UI buttons are disabled when invalid.

### 3.6 Health Center

Cases:

- provider OK/error/reauth,
- credential missing/revoked,
- bot disabled/error/connected,
- proxy disabled/error/ok,
- storage path unavailable,
- artifact root unavailable,
- open gateway stopped/running/error,
- search/voice/MCP unavailable.

Done means:

- user has one place to inspect system health,
- copy diagnostics is redacted,
- every subsystem uses reason-coded status.

### 3.7 First-run

Cases:

- no connections,
- invalid key format,
- provider test 401,
- model fetch error,
- fetched-empty,
- choose default,
- send smoke prompt.

Done means:

- user can get from empty workspace to first real message in four steps,
- failures are inline,
- no fallback-as-success.

### 3.8 Quick Chat

Cases:

- global shortcut registered,
- hotkey conflict,
- no ready model,
- ready model,
- existing active session context,
- send/stop,
- close/reopen preserves draft policy.

Done means:

- Quick Chat is an entry point to the same readiness/runtime contract,
- it does not introduce a second send path.

### 3.9 Integrations

Cases:

- Open Gateway auth/SSE/errors,
- Memory inspect/delete,
- Voice permission/transcription errors,
- Search citations/export,
- MCP server install/connect/tool list,
- Sources/Skills/Automations scope and disable.

Done means:

- each integration is visible, scoped, disable-able, and testable,
- no integration silently widens tool permissions.

## 4. PR Checklist

Copy this into PR descriptions:

```md
## Contract
- [ ] Data/API/event/state changes described
- [ ] docs/design-system.md or docs/full-product-test-plan.md updated if contract changed

## User Flow
- [ ] Main happy path described
- [ ] Failure path described
- [ ] Reload/persistence behavior described

## Tests
- [ ] core/storage/runtime/desktop tests added or marked N/A with reason
- [ ] renderer pure helper test added where practical
- [ ] fixture scenario added/updated
- [ ] smoke.md path added/updated
- [ ] light/dark/narrow screenshots captured or visual gate marked N/A with reason

## Security
- [ ] secrets redacted
- [ ] raw provider errors generalized
- [ ] path boundary uses realpath containment
- [ ] renderer does not receive arbitrary absolute paths
- [ ] Electron navigation/window-open/sandbox boundary unchanged or tightened
- [ ] console/log behavior checked

## Not Included
- [ ] Follow-up work listed explicitly
```

## 5. Command Gate

Before merging any non-doc-only PR:

```bash
npm run build
npm run typecheck
npm test --workspaces --if-present
```

For UI surfaces, also run the relevant fixture smoke path from `apps/desktop/tests/smoke.md`.

## 6. Current Immediate Next Work

Priority order after the P0 stale-session fix:

1. Artifact Workbench completion: real Save As, artifact error fixture, deleted/too-large/unsupported smoke.
2. ModelCatalogEntry and unsupported default guard.
3. Workstation shell/session status.
4. Turn controls.
5. Health Center.
6. First-run stepper.
7. Quick Chat.
8. Open Gateway / Memory / Voice / Search / MCP / Sources-Skills-Automations.

The next implementation PR should target item 1 and must not expand scope into unrelated UI polish.
