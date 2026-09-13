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

# Maka Code Bug / Flow Audit - 2026-05-22

> Archived on 2026-07-13. This is a point-in-time audit, not current implementation guidance.

Owner: @xuan  
Thread: #my-ai:02c56cb6  
Scope: current Maka code, runtime/main/renderer/core/storage/settings surfaces. Layout work is tracked separately by @yuejing.

## Fixed on main

### 1. Shell safe-prefix commands bypassed Ask prompt

Commit: `778077d Fix runtime failure states and shell permission gaps`

Evidence:
- `packages/core/src/permission.ts` categorized safe-prefix commands before checking generic shell control operators.
- Commands like `echo hello > out.txt`, `cat package.json | wc -l`, `pwd && npm test`, backticks, and `$()` could be treated as `shell_safe`.

Impact:
- Ask/Explore mode could auto-allow command forms that mutate files, chain commands, or expand secret-bearing command substitutions.

Fix:
- Added `SHELL_CONTROL_PATTERNS` and classify those commands as `shell_unsafe` before safe-prefix matching.
- Regression tests added in `packages/core/src/__tests__/permission.test.ts`.

### 2. Backend build/send failure after user append left false session state

Commit: `778077d Fix runtime failure states and shell permission gaps`

Evidence:
- `packages/runtime/src/session-manager.ts` appended the user message and turn running state before backend creation, but backend build failures happened before the active stream bookkeeping/finally state transition.

Impact:
- A persisted user message could be left with a running/active session instead of a failed/blocked turn.

Fix:
- Wrapped connection lock, backend build, stream bookkeeping, and backend send in a single try/finally.
- Catch appends failed turn state and final header becomes `blocked/unknown`.
- Regression test added in `packages/runtime/src/__tests__/session-manager.test.ts`.

### 3. Renderer stale message refresh could overwrite current chat

Commit: `778077d Fix runtime failure states and shell permission gaps`

Evidence:
- `apps/desktop/src/renderer/main.tsx` `refreshMessages(sessionId)` always called `setMessages(await readMessages(sessionId))`.

Impact:
- If the user switched sessions while an async read was in flight, the old session could overwrite the active chat view.

Fix:
- Guard `setMessages` with `activeIdRef.current === sessionId`.

### 4. Streaming / permission UI could remain stuck after error/abort/complete

Commit: `778077d Fix runtime failure states and shell permission gaps`

Evidence:
- Error and abort events refreshed sessions/messages but did not consistently clear streaming text or pending permission dialog state.

Impact:
- Composer/session UI could remain in a streaming/waiting state after the turn had already failed or aborted.

Fix:
- Added `clearStreaming(sessionId)` and clear pending permission state on error/abort; non-permission complete clears streaming.

### 5. Packaged app could create FakeBackend sessions from renderer input

Commit: `778077d Fix runtime failure states and shell permission gaps`

Evidence:
- `apps/desktop/src/main/main.ts` accepted renderer `sessions:create({ backend: 'fake' })` directly.

Impact:
- Packaged app had a fake-session creation path that bypassed the real readiness contract.

Fix:
- Added `canCreateFakeSessionFromRenderer()` and only allow fake sessions in unpackaged dev/visual-smoke contexts.

### 6. Skills were listed but not injected into runtime prompts

Commit: `a4a9b7e Wire skills into prompts and stop parked permissions`

Evidence:
- `skills:list` scanned `{workspaceRoot}/skills/*/SKILL.md`, but `buildSystemPrompt()` only included personalization.

Impact:
- UI made skills look installed, but the model never received their instructions.

Fix:
- Extracted skill scanning/prompt assembly into `apps/desktop/src/main/skills.ts`.
- `buildSystemPrompt()` now includes bounded local skill instructions.
- Prompt fragment explicitly says skills are lower priority, cannot grant tools, cannot bypass permission, and cannot override higher-priority instructions.
- Tests added in `apps/desktop/src/main/__tests__/skills.test.ts`.

### 7. Stop did not reject parked tool permission requests

Commit: `a4a9b7e Wire skills into prompts and stop parked permissions`

Evidence:
- `AiSdkBackend.stop()` aborted the model stream but did not end the current permission-engine turn.

Impact:
- If a tool was waiting on a permission dialog, Stop could leave the tool wrapper parked until a later user decision.

Fix:
- `stop()` now calls `permissionEngine.endTurn(currentTurnId, 'aborted')`.
- Regression test added in `packages/runtime/src/__tests__/ai-sdk-backend.test.ts`.

### 8. Auto-approved read tools could escape session cwd

Commit: `21522a9 Constrain read tools to session cwd`

Evidence:
- `Read`, `Glob`, and `Grep` were `permissionRequired: false` but accepted absolute paths, `../`, or symlink escapes.

Impact:
- Explore/Ask mode could read files outside the session workspace without a prompt.

Fix:
- `Read` rejects absolute paths and uses lexical + realpath containment under session cwd.
- `Glob` rejects absolute/parent-traversal patterns and constrains optional cwd.
- `Grep` constrains optional path under session cwd.
- Tests added in `packages/runtime/src/__tests__/builtin-tools.test.ts`.

### 9. Main-process stream catch emitted random turn ids

Commit: `1e41f64 Preserve turn ids for stream errors`

Evidence:
- `streamEvents()` catch synthesized renderer error events with `turnId: randomUUID()`.

Impact:
- Even after runtime persisted the correct failed turn, the renderer error event could be detached from the actual turn lineage.

Fix:
- Send/retry/regenerate/quick-chat now generate explicit turn ids and pass them as `fallbackTurnId` into `streamEvents()`.
- Catch uses that id and emits both session and turn status change events.

### 10. Prompt assembly lacked workspace instruction context

Commit: `0afcf2e Inject workspace instructions into prompts`

Evidence:
- `buildSystemPrompt()` included personalization and installed skills, but did not read project-local engineering instructions from the active session cwd.

Impact:
- Coding sessions could ignore repository-local rules such as `AGENTS.md` unless the user repeated them manually.

Fix:
- Runtime system-prompt callbacks now receive `{ sessionId, cwd, workspaceRoot }`.
- Desktop prompt assembly reads bounded allowlisted files from the session cwd: `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`.
- The loader realpath-checks containment, skips symlink escapes, strips control chars, caps per-file and total prompt size, and marks workspace files as lower-priority/untrusted context that cannot grant tools or weaken permissions.

### 11. Health Center had validation signals but no LLM runtime probe signal

Commit: current runtime health-probe change set

Evidence:
- `health:getSnapshot` emitted `healthSignalFromConnection()` only, so LLM rows represented connection-test validation (`lastTestStatus`) but not the real send/stream/abort path.

Impact:
- The UI correctly said "verified != operational", but had no first runtime signal to show whether a connection had actually sent successfully, failed, or been aborted.

Fix:
- LLM telemetry records now include `connectionSlug`.
- `TelemetryRepo` can return the latest runtime probe per connection/model.
- Health snapshots now emit a separate `runtime_probe` signal per configured enabled connection: unknown before first send, ok after last success, info after user abort, warning after last runtime error.

### 12. Write/Edit mutation tools could escape session cwd

Commit: current write-tool containment change set

Evidence:
- `Read`, `Glob`, and `Grep` were constrained to session cwd, but `Write` and `Edit` still resolved paths with `resolve(cwd, path)` only.
- Absolute paths and `../` traversal could write outside the session cwd when the permission mode allowed the tool, and symlink parents could route a write outside the workspace.

Impact:
- Even with permission prompts, the tool contract said session-cwd work, but the implementation allowed broader filesystem mutation than the user could reasonably infer.
- In Execute mode, `Write`/`Edit` are allowed by policy and therefore needed a hard path boundary too.

Fix:
- `Write` now rejects absolute paths, parent traversal, and symlink-parent escapes before writing.
- `Edit` now reuses the existing realpath containment helper and rejects absolute paths, parent traversal, and symlink file escapes.
- Regression tests added for both mutation tools.

### 13. Session store accepted path-shaped session ids

Commit: current session-id containment change set

Evidence:
- `FileSessionStore.sessionDir(sessionId)` joined renderer/runtime supplied session ids directly under `workspaceRoot/sessions`.
- Operations such as `remove(sessionId)` could receive a traversal-shaped id before path validation existed.

Impact:
- Most normal calls use generated UUIDs, but IPC/runtime boundaries should still reject path-shaped ids before any filesystem operation.

Fix:
- Session store now accepts only bounded ids matching `[A-Za-z0-9_-]{1,128}`.
- `list()` skips malformed folders.
- All filesystem paths and write queues assert the same id contract before reading, writing, or removing.
- Regression test verifies traversal ids reject and do not delete an outside victim directory.

## Remaining Product / Architecture Findings

### A. Coming Soon settings surfaces still need a product decision

Evidence:
- `apps/desktop/src/renderer/settings/SettingsModal.tsx` exposes `daily-review`, `voice-models`, `open-gateway`, and `search` as enabled nav items with Coming Soon copy.
- `packages/core/src/settings.ts` has section ids, but there is no real settings contract for these features yet.

Risk:
- This is honest enough as product-stance copy, but still takes Settings real estate and can feel like shipped capability.

Recommendation:
- @WAWQAQ should choose per page: implement now, hide from nav, or keep as disabled roadmap copy.
- If kept visible, each page needs a real snapshot/status source before it becomes actionable.

### B. Health / Capability center is still only partially probe-complete

Evidence:
- `apps/desktop/src/main/capability-snapshot.ts` marks Computer Use, Activity, Voice, Open Gateway, and Memory Write as `not_available` with scaffold reasons.
- Bot readiness is now safer.
- LLM connection health now has a first real runtime signal from usage telemetry.
- Most non-LLM runtime probes are still placeholders.

Risk:
- UI is no longer lying about operational state, but the actual parity capabilities are not implemented.

Recommendation:
- Next engineering PRs should implement real probes before flipping any non-LLM row to enabled/operational.
- Computer Use requires real helper process + AX/screenshot probe; Voice requires mic/TTS chunk probe; Open Gateway requires heartbeat.

### C. Main / renderer / settings / UI component files are still too large

Current sizes:
- `apps/desktop/src/main/main.ts`: 1300 lines
- `apps/desktop/src/renderer/main.tsx`: 1428 lines
- `apps/desktop/src/renderer/settings/SettingsModal.tsx`: 1643 lines
- `packages/ui/src/components.tsx`: 2654 lines
- `packages/runtime/src/ai-sdk-backend.ts`: 912 lines

Risk:
- Fixes are harder to isolate; merge conflicts increase; subtle event/state coupling is easy to miss.

Recommendation:
- Split by ownership, not by arbitrary helpers:
  - main IPC: sessions/connections/settings/artifacts/capabilities/skills modules
  - renderer: session event reducer / settings shell / chat shell
  - ui components: chat, sessions, permissions, composer, tool activity modules
  - runtime backend: stream pump, tool wrapper, telemetry/artifact hooks

### D. Open Gateway / search / voice / daily review are still no-op roadmap features

Evidence:
- They have Coming Soon UI copy and capability snapshot placeholders but no backend implementations.

Risk:
- Users may interpret the nav as feature presence.

Recommendation:
- Do not wire buttons/toggles until each has snapshot/degraded/revoke/audit/probe contracts.
- Keep all four behind disabled copy or hide them until implementation starts.

## Verification Log

After the latest fixes:
- `git diff --check` passed.
- `npm run typecheck` passed.
- Full `npm test --workspaces --if-present` passed after `0afcf2e`: core 122 / storage 38 / runtime 99 / desktop 327 = 586.
- Full `npm test --workspaces --if-present` passed after runtime health probe work: core 124 / storage 39 / runtime 99 / desktop 327 = 589.
- Pushed commits so far: `778077d`, `a4a9b7e`, `21522a9`, `1e41f64`, `5c324c4`, `0afcf2e`.
