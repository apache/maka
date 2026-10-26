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

`WaitForEvent` is an ordinary asynchronous tool for Goal-enabled Runs. It keeps
its original Turn, Run, invocation and tool operation pending while the Host
observes a supported condition. One normal tool result resumes the same model
loop. Waiting does not settle the Goal, yield the Turn, reserve a successor,
refund an iteration or reset an execution budget. AI SDK direct tools and nested
Code Mode calls use the same durable tool boundary. ACP executors retain their
existing tool surface; this change adds no Host tool bridge.

The Host latches the capability to the admitted Run. Pausing, clearing or
replacing its Goal does not revoke an admitted ordinary tool, and another wait
in that Run remains available. New ordinary Session Runs do not receive the
capability. `current_turn` input interrupts the wait at the existing steering
boundary; `next_turn` input remains queued. Code Mode drains already-dispatched
siblings before returning to that boundary.

The source registry supports managed same-Session background ShellRuns.
Computer text waits retain their existing native implementation. Source notifications are hints:
the Host rereads authority and shares concurrency, Retry-After and cooldown
budgets. Sources without push support use bounded Host polling. A nullable
absolute deadline and rolling observation checkpoints keep scheduler limits
separate from business outcomes. A terminal ShellRun may have failed; inspect
its original reference with `Read`. Observation never restarts or takes ownership
of a source process.

The Runtime event log is the authority for tool completion. Registration proves
the original T1 dispatch; the original T2 response proves consumption. A lost
consumption acknowledgement is reconstructed from T2 without repeating the tool
or blocking the model loop. The wait record is not a persisted JavaScript Promise:
Host restart follows existing Runtime recovery and never creates a successor
from an in-turn wait alone.

A Turn that ends naturally may separately produce a structured Goal waiting
condition. Host observation replaces that waiting timer while preserving the
existing evaluation, settlement and single continuation admission.

Session continuity exposes independently identified waits, including after Goal
clear. `session.event-wait.cancel` validates the exact consumer identity. For a
tool wait it returns cancellation to that tool without pausing the Goal or
stopping the source. Stop still cancels the Run. A natural Goal waiting consumer
uses its Goal generation/revision and existing Goal cancellation semantics.
Portable Session copies omit wait authority; same-root checkpoints retain it
without granting execution or duplicate-delivery authority.

See the [Host observation contract](../../docs/goal-event-wait-consumers.md) for
consumer identities and lifecycle boundaries.

## Extension rules

- Add backend behavior behind `AgentBackend` and register it through the existing registry.
- Add tools through the builtin/tool composition seams; keep filesystem and shell effects behind `WorkspaceExecutor`.
- Put shared pure contracts in `packages/core` and interactive Runtime state in the SQLite control plane owned by `packages/storage`.
- Expose supported package APIs through a declared `package.json` `exports` subpath rather than importing internal files from another package.
- Keep provider credentials and Electron IPC outside this package. The product shell resolves credentials and passes only the dependencies required for execution.

For the system-level model and code-reading map, start with the root `ARCHITECTURE.md`. Sandbox-specific contracts live in `src/sandbox/README.md`.
