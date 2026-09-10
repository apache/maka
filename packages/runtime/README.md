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

Only the **subpaths declared in `package.json` `exports`** are supported public APIs. There is **no package-root barrel**: `import('@maka/runtime')` fails with `ERR_PACKAGE_PATH_NOT_EXPORTED`. Do not import undeclared internal source paths from another package.

Useful entry points and import examples:

- `SessionManager` and `BackendRegistry` — `@maka/runtime/session-manager`
  ```ts
  import { SessionManager, BackendRegistry } from "@maka/runtime/session-manager";
  ```
- `AiSdkBackend` — `@maka/runtime/ai-sdk-backend`
  ```ts
  import { AiSdkBackend } from "@maka/runtime/ai-sdk-backend";
  ```
  `FakeBackend` is test-only: it lives under `test-only/`, is exported as `@maka/runtime/test-only/fake-backend`, and release packaging drops that directory, so no production module may import it. Tests and the Desktop E2E run reach it through the composition's `primaryBackendFactory` seam.
- Session execution-boundary APIs for managed sandbox expansion and explicit bypass (`@maka/runtime/sandbox` and related declared subpaths).
- `buildBuiltinTools()` and the workspace executor interfaces (`@maka/runtime/builtin-tools`, `@maka/runtime/shell-tools`) for tool composition.
- `RuntimeKernel`, runtime events, projections, and recovery helpers (`@maka/runtime/runtime-kernel` and related declared subpaths) for execution lifecycle.

Shared execution composition (where `BackendRegistry` and `SessionManager` are constructed) lives in `packages/runtime-host/src/server/execution-composition.ts`. Other clients execute Maka through Runtime Host rather than composing Runtime directly. The Desktop product shell is one host among those clients; do not treat `apps/desktop/src/main/main.ts` as the Runtime composition source of truth.

## Extension rules

- Add backend behavior behind `AgentBackend` and register it through the existing registry.
- Add tools through the builtin/tool composition seams; keep filesystem and shell effects behind `WorkspaceExecutor`.
- Put shared pure contracts in `packages/core` and interactive Runtime state in the SQLite control plane owned by `packages/storage`.
- Expose supported package APIs only through a declared `package.json` subpath. Do not add or rely on a package-root barrel unless `exports` gains a `"."` entry.
- Keep provider credentials and Electron IPC outside this package. The product shell resolves credentials and passes only the dependencies required for execution.

For the system-level model and code-reading map, start with the root `ARCHITECTURE.md`. Sandbox-specific contracts live in `src/sandbox/README.md`.
