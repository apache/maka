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
| [generated/runtime.ts](src/generated/runtime.ts) | Rust wire types and deployment declarations |
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

UI modules export synchronous `activate(context)` and return the root, commands, panels, settings pages and tool renderers declared by their package. The returned `UiExports` is keyed by the declaration’s local IDs, with matching `kind` values: commands provide `run({ sessionId })`; the other contributions provide `render(props)`. A `root` export provides the complete application selected by the deployment source’s `ui: { path, id }`; it uses the same package, activation and NSH components as other UI contributions. There is no built-in Maka fallback for an absent root. They use ordinary NSH components in the shared workbench on desktop and terminal. Installed plugins are trusted and use the existing client capabilities; `nsh.cleanup` releases their activation-owned subscriptions and resources. Host services receive request-scoped imports and attachments, without ambient Node APIs.

Root `render` receives `UiRootProps` containing `{ context, runtime, restored }`. Optional `prepareReload()` persists owned drafts and returns JSON before replacing the shared VM. That JSON is restored only for the same instance identity, contribution ID and package ID, including a new revision of that package; a different root receives `null`. If preparation rejects before replacement, the old root remains and input resumes. A new root’s activation failure is reported without rolling back. UI reload preserves the Client, operation journal and accepted Host work; recover original operations rather than replaying them. The default Maka root saves its conversation draft before handing off; custom roots own their draft and state handoff. See the [UI authoring guide](../../skills/maka-plugin-authoring/references/ui-plugins.md).

Guest realms provide `TextEncoder`, `TextDecoder`, `atob`, `URL` and `URLSearchParams` for pure text and byte conversion. Decode Base64 to bytes with `Uint8Array.from(atob(value), c => c.charCodeAt(0))`; these APIs grant no filesystem or network access.

TypeScript checks authoring mistakes. The runtime separately validates values, contract compatibility, resource slots and permissions. See the [plugin guide](../../plugins/README.md) and [runnable starter](../../skills/maka-plugin-authoring/references/quickstart.md).
