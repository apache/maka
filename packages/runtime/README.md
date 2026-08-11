# `@maka/runtime`

`@maka/runtime` is Maka's pure-Node agent runtime. It owns model/backend execution, session sandbox-boundary control flow, event projection, context handling, recovery, and sandbox-aware workspace execution. Product shells compose it; they do not reimplement its loop.

## Public seam

The package root barrel and the subpaths declared in `package.json` are supported public APIs. Do not import undeclared internal source paths from another package. The main integration points are:

- `SessionManager` for session and turn orchestration.
- `BackendRegistry` and `AgentBackend` for backend selection.
- `AiSdkBackend` and `FakeBackend` for the existing backend implementations.
- Session execution-boundary APIs for managed sandbox expansion and explicit bypass.
- `buildBuiltinTools()` and the workspace executor interfaces for tool composition.
- `RuntimeRunner`, runtime events, projections, and recovery helpers for invocation lifecycle.

Desktop composition lives in `apps/desktop/src/main/main.ts`. Other clients execute Maka through Runtime Host rather than composing Runtime directly.

## Extension rules

- Add backend behavior behind `AgentBackend` and register it through the existing registry.
- Add tools through the builtin/tool composition seams; keep filesystem and shell effects behind `WorkspaceExecutor`.
- Put shared pure contracts in `packages/core` and durable JSONL state in `packages/storage`.
- Expose supported package APIs through the root barrel or a declared `package.json` subpath rather than importing internal files from another package.
- Keep provider credentials and Electron IPC outside this package. The product shell resolves credentials and passes only the dependencies required for execution.

For the system-level model and code-reading map, start with the root `ARCHITECTURE.md`. Sandbox-specific contracts live in `src/sandbox/README.md`.
