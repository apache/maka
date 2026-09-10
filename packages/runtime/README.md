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

`@maka/runtime` is Maka's pure-Node agent runtime. It owns model/backend execution, session sandbox-boundary control flow, event projection, context handling, recovery, and sandbox-aware workspace execution. Runtime Host composes it; clients do not reimplement its loop.

## Public seam

The subpaths declared in [`package.json`](./package.json) are supported public APIs. The package root (`@maka/runtime`) is not exported. Import through a declared subpath rather than an internal source path:

```ts
import { SessionManager } from '@maka/runtime/session-manager';
import { AiSdkBackend } from '@maka/runtime/ai-sdk-backend';
```

The main integration points are:

- `SessionManager` for session and turn orchestration.
- `BackendRegistry` and `AgentBackend` for backend selection.
- `AiSdkBackend` for the shipped backend implementation. `FakeBackend` is test-only: it lives under `test-only/`, is exported as `@maka/runtime/test-only/fake-backend`, and release packaging drops that directory, so no production module may import it. Tests and the Desktop E2E run reach it through the composition's `primaryBackendFactory` seam.
- Session execution-boundary APIs for managed sandbox expansion and explicit bypass.
- `buildBuiltinTools()` and the workspace executor interfaces for tool composition.
- `RuntimeKernel`, runtime events, projections, and recovery helpers for execution lifecycle.

The shared execution composition lives in [`packages/runtime-host/src/server/execution-composition.ts`](../runtime-host/src/server/execution-composition.ts). Desktop, TUI, and CLI execute Maka through Runtime Host.

## Extension rules

- Add backend behavior behind `AgentBackend` and register it through the existing registry.
- Add tools through the builtin/tool composition seams; keep filesystem and shell effects behind `WorkspaceExecutor`.
- Put shared pure contracts in `packages/core` and interactive Runtime state in the SQLite control plane owned by `packages/storage`.
- Expose supported package APIs through a declared `package.json` subpath rather than importing internal files from another package.
- Keep provider credentials and Electron IPC outside this package. The product shell resolves credentials and passes only the dependencies required for execution.

For the system-level model and code-reading map, start with the root `ARCHITECTURE.md`. Sandbox-specific contracts live in `src/sandbox/README.md`.
