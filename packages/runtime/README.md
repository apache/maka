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

# `@maka/runtime`

`@maka/runtime` is Maka's pure-Node agent runtime. It owns model/backend execution, session sandbox-boundary control flow, event projection, context handling, recovery, and sandbox-aware workspace execution. Product shells compose it; they do not reimplement its loop.

## Public seam

The supported public API is the set of subpaths declared in the `exports` map of `package.json`. The package root is not exported: `import('@maka/runtime')` fails with `ERR_PACKAGE_PATH_NOT_EXPORTED`. Do not import undeclared internal source paths from another package. For example:

```ts
import { SessionManager, BackendRegistry } from '@maka/runtime/session-manager';
import { AiSdkBackend } from '@maka/runtime/ai-sdk-backend';
import { buildBuiltinTools } from '@maka/runtime/builtin-tools';
```

The main integration points are:

- `SessionManager` for session and turn orchestration.
- `BackendRegistry` and `AgentBackend` for backend selection.
- `AiSdkBackend` for the shipped backend implementation. `FakeBackend` is test-only: it lives under `test-only/`, is exported as `@maka/runtime/test-only/fake-backend`, and release packaging drops that directory, so no production module may import it. Tests and the Desktop E2E run reach it through the composition's `primaryBackendFactory` seam.
- Session execution-boundary APIs for managed sandbox expansion and explicit bypass.
- `buildBuiltinTools()` and the workspace executor interfaces for tool composition.
- `RuntimeKernel`, runtime events, projections, and recovery helpers for execution lifecycle.

Shared execution composition — where `BackendRegistry` and `SessionManager` are constructed — lives in the Runtime Host at [`packages/runtime-host/src/server/execution-composition.ts`](../runtime-host/src/server/execution-composition.ts). Clients, including Desktop, execute Maka through Runtime Host rather than composing Runtime directly.

## Searching retained tool results

When the tool-result archive capability is bound, `Grep` accepts the same
`maka://runtime/tool-results/<event-id>` addresses as `Read`. For example,
`Grep({ path: resultAddress, pattern: 'timeout|ECONNRESET' })` searches the
Session's retained readable text without repeating the source operation.
Use `Read` with a zero-based line offset to expand a match; `readHints` supplies
digest-bound Read parameters when a long matching line is shown as an excerpt.

Searches use ripgrep regex semantics, count matching lines rather than regex
occurrences, and retain at most 50 matching lines in a complete JSON response
of at most 7,500 bytes. `omittedLines` reports matching lines left out of the
response; `truncated` also covers clipped excerpts. Execution metadata preserves
known upstream output truncation, so counts describe retained content. Missing
evidence and interrupted searches are errors, not evidence of zero matches.

## Background-task readiness

`Bash` background runs return a durable runtime-task ref and expose the native
process id when available. A process id published after startup is captured on
the next task observation, output flush, or finalization.
`BackgroundTaskHealth` deliberately keeps
the process lifecycle (`starting`, `running`, or terminal, with timestamps and
captured output) separate from endpoint readiness. An endpoint is `healthy`
only after an explicit HTTP(S) probe succeeds; an omitted probe is
`not_checked`, and a failed or policy-blocked probe is `unknown`. Consumers must
not infer HTTP readiness from the process status alone.

## Explicit event waits

`WaitForEvent` is available to AI SDK direct-tool Turns with an active Goal.
The production source is a locally owned, same-Session managed background Bash
task: `shell_run / background_task / terminal@1`, with an empty parameter object
and its canonical `maka://runtime/background-tasks/<id>` reference. The Host verifies
the task against its immutable invocation and tool call/dispatch/result facts;
references, UI projections and process IDs are not access credentials. Code Mode
may create a background task, but must return to direct mode to register a wait.
ACP, nested Code Mode and plugin executors cannot register waits.

The tool requires a direct, exclusive tool step; a successful Host registration produces an in-memory
control receipt that ends the Turn with `event_wait` after persisting its result.
Persisted JSON and ordinary tool output cannot manufacture that receipt.

Runtime Host's `HostGoalEventWaitBridge` binds registration to the current Goal
control generation and Root execution. Its narrow storage operations atomically
register the gate, settle the source once, and queue an existing Goal continuation.
The continuation freezes execution IDs, prompt and typed result provenance. Root
admission atomically consumes that continuation and acknowledges delivery. The
observation outcome remains available after admission; it is not cancellation.

While the gate is outstanding, the normal Goal evaluator and waiting timer cannot
start work. Observation uses the existing bounded Host observation service. Busy
admission and temporarily unknown authorization retain the original continuation;
new user work keeps its normal admission priority. Pause/cancellation invalidate
the old generation. Portable Session copies pause linked Goals and discard the
wait linkage; same-root backups retain it.

Recovery distinguishes a queued continuation from an admitted successor. A queued
result or timeout retains its frozen execution IDs and input across restart, and
retries through the existing Root admission checks. If admission commits but its
acknowledgement is lost before the Root owner adopts it, the Host requests drain
and fences further admission for that Session. Restart the Host before resuming
the Goal: recovery closes an admitted Goal Turn without a Run as `app_restarted`
and pauses the Goal. An explicit user resume starts a fresh continuation under a
new control generation; it does not redeliver the old wait. If a Run already
exists, its recovery follows the normal Runtime policy. This boundary does not
provide transparent retry or exactly-once execution of external side effects.

Terminal means completed, failed, timed out or cancelled, not necessarily successful.
The continuation uses `Read` on the original reference to inspect output and exit
status. Orphaned tasks produce `source_unavailable` and are never automatically
restarted. Confirmed disappearance or revoked access closes the wait and pauses
the Goal with a bounded diagnostic; temporary storage failures remain unknown.

Goal projections include the current outstanding wait, its reason/deadline and
observation or admission phase. `goal.event-wait.cancel` targets the original
Goal, generation and wait ID plus Goal revision. It pauses the Goal and suppresses
unadmitted delivery without stopping the background process. Repeated or stale
requests report cancellation, admission or conflict without targeting newer work.
ShellRun notifications only prompt authoritative rereads; observing a task does
not take ownership of its sandbox, process lifetime or completion cleanup.

## Extension rules

- Add backend behavior behind `AgentBackend` and register it through the existing registry.
- Add tools through the builtin/tool composition seams; keep filesystem and shell effects behind `WorkspaceExecutor`.
- Put shared pure contracts in `packages/core` and interactive Runtime state in the SQLite control plane owned by `packages/storage`.
- Expose supported package APIs through a declared `package.json` `exports` subpath rather than importing internal files from another package.
- Keep provider credentials and Electron IPC outside this package. The product shell resolves credentials and passes only the dependencies required for execution.

For the system-level model and code-reading map, start with the root `ARCHITECTURE.md`. Sandbox-specific contracts live in `src/sandbox/README.md`.
