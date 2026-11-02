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

# Maka plugin SDK

[简体中文](README.zh-CN.md)

TypeScript contracts and helpers for Maka Host services and NSH workbench UI plugins. Import from `@maka-agent/plugin-sdk`; bundle guest code before giving it to the runtime.

| Source | Purpose |
| --- | --- |
| [index.ts](src/index.ts) | `HostService`, `RequestContext` and public exports |
| [workbench.ts](src/workbench.ts) | Shared NSH UI plugin activation and contribution types |
| [workbench-views.ts](src/workbench-views.ts) | Conversation, composer and settings view contracts |
| [composer-view.ts](src/composer-view.ts) | Composer inputs and the resident session projection |
| [workspace-view.ts](src/workspace-view.ts) | Workspace preview contract, actions and view handles |
| [generated/runtime.ts](src/generated/runtime.ts) | Rust wire types and deployment declarations |
| [generated/methods.ts](src/generated/methods.ts) | Typed Host service method inputs and outputs |
| [contracts.ts](src/contracts.ts) | Host service contracts |
| [configurations.ts](src/configurations.ts) | Native configuration schemas |
| [native.ts](src/native.ts) | Native implementation definitions for package declarations |

Rust declarations are the source for generated files. After changing them, run from the repository root:

```sh
npm --workspace @maka-agent/plugin-sdk run schema:generate
npm --workspace @maka-agent/plugin-sdk run schema:check
npm --workspace @maka-agent/plugin-sdk run typecheck
```

Generation uses [maka-schema](../../tools/schema/README.md) and does not build the product or V8. The runtime also exports its catalog through `maka application schema`.

Agent tools project existing service methods. Set `target` to `{ kind: 'import', name: 'files' }` for a bound service or `{ kind: 'export', name: 'agent' }` for the Agent's own Session API, followed by `method`, `name`, `description`, `result` and `confirmation`. Own exports need no self import. Both routes retain normal Host grants and original mutation receipts. Other plugins can import `contracts.agent` to use the same Session operations directly; model-tool availability is selected separately in the Agent configuration.

UI modules export synchronous `activate(context)` returning `UiActivation`: `{ exports, prepareReload? }`. Its `exports` map uses the package declaration’s local IDs and matching `kind` values for roots, embedded views, commands, panels, settings pages and tool renderers. A `root` renders the complete application selected by the deployment source’s `ui: { path, id }`; `UiRootProps` contains `{ context, runtime }`. These contributions use ordinary NSH components on desktop and terminal. Installed plugins use the existing trusted client capabilities; `nsh.cleanup` releases resources owned by their activation. Host services receive request-scoped imports and attachments, without ambient Node APIs.

Use `context.application` for application calls through the UI instance’s declared service bindings. It is the native application client, retaining the Client, journal and original receipts. `context.services[importName][index]` selects a particular bound provider, including imports with multiple providers; `context.operations` recovers the instance’s original mutation receipts. `context.host` and `maka/host` expose the full client to trusted UI code, including root and catalog integration. Keep controllers tied to the application client of their owning activation.

An embedded view declares `{ kind: 'view', contract: 'shared.contract.id' }` and returns a matching implementation with `render({ context, runtime, input })`. Define the shared input type with `defineUiViewContract<Input>(id)`. A consumer selects a `UiTarget` (`{ path, id }`) and calls `runtime.renderView(target, contract, input)`; `runtime.view(target, contract)` resolves the contribution and checks its declared kind and contract. The target can come from plugin configuration, allowing another installed UI instance to provide that surface. The contracts in `workbench-views.ts`, `composer-view.ts` and `workspace-view.ts` cover conversation navigation/session/preview, the composer, settings and workspace preview; they specify inputs and ownership callbacks rather than giving consumers the provider’s private state.

Commands implement `run({ sessionId, argument? })` and optional `enabled(context)`. Their declarations supply `title` and optional `description`, `shortcut`, `order`, `trigger`, `takesArgument` and `hint` metadata; accepting arguments requires a trigger. Roots can inspect the contribution catalog, use `runtime.commandEnabled(...)` for availability and call `runtime.invoke(...)` to run the command.

Keep shared business state in the owning activation. Before replacing the shared VM, its optional `prepareReload()` persists owned edits and returns JSON. The same instance identity and package ID receive that value through `context.restored`, including a new revision of the package; a new instance receives `null`. If preparation rejects, the existing UI remains and input resumes. UI reload preserves the Client, operation journal and accepted Host work; recover original operations rather than replaying them. See the [UI authoring guide](../../skills/maka-plugin-authoring/references/ui-plugins.md).

Guest realms provide `TextEncoder`, `TextDecoder`, `atob`, `URL` and `URLSearchParams` for pure text and byte conversion. Decode Base64 to bytes with `Uint8Array.from(atob(value), c => c.charCodeAt(0))`; these APIs grant no filesystem or network access.

TypeScript checks authoring mistakes. The runtime separately validates values, contract compatibility, resource slots and permissions. See the [plugin guide](../../plugins/README.md) and [runnable starter](../../skills/maka-plugin-authoring/references/quickstart.md).
