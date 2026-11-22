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

# Plugins

[简体中文](README.zh-CN.md)

Each leaf `package.ts` under `plugins/` declares a deployable plugin (`application.host`, `application.ui`, or `application.composition`) along with its configuration schema, service imports, and exports. Cargo crates provide the underlying Rust implementations: one complex plugin may span multiple crates, while related plugin entries can share a single native crate.

| Directory | Scope |
| --- | --- |
| [`agent/`](agent/README.md) | Conversations, Rooms, model protocols, durable execution engine, Code Mode, MCP client, Goals, and scheduling |
| `workspace/` | Sandboxed file tools (`Read`, `Write`, `Edit`, `ApplyPatch`, `Glob`, `List`), background shells/PTYs, Web fetch/search, Computer Use bindings, and Decisions API |
| `settings/` | Model provider connections, credentials, usage accounting, and user preferences |
| `skills/` | Local, remote, and bundled `SKILL.md` discovery, paged reads, and installation |
| `interactions/` | Structured user questions (`AskUserQuestion`) and permission escalation prompts |
| `application/` | Runtime plugin installation, deployment inspection, and live composition editing |
| `shared/` | Shared TypeScript contract helpers |

## Host and UI plugin model

- **Host entries (`usePackage: "host"`)** — Run either a registered native Rust factory or a bundled JavaScript `HostService` on the background V8 runtime, receiving only the explicit capabilities bound in the deployment.
- **UI entries (`usePackage: "ui"`)** — Run inside the shared NSH workbench VM across both terminal and desktop shells. `activate(context)` returns `{ exports, prepareReload? }` to contribute roots, typed `view` slots (`UiRuntime.renderView`), commands, panels, settings pages, or custom tool cards. `context.services` and `context.operations` bind directly to the instance's declared Host imports and two-phase operation receipts.
- **Compositions (`usePackage: "composition"` / `base.package`)** — Bundle reusable instance graphs. Default Maka installations pin a root baseline composition (`base.package`) and layer user `overrides` (`configurationFields`, `remove`) plus standalone `instances` without shifting existing state identities; see [product bundle](../products/maka/bundle/README.md).

## Building and wiring a plugin

Build an individual plugin package from the repository root:

```sh
node scripts/plugins/build.mjs --plugin plugins/workspace/workspace-web --output /tmp/maka-web-bundle
maka application inspect-package --package /tmp/maka-web-bundle/packages/workspace-web
```

To ship a plugin in the default Maka distribution, add its directory to [`products/maka/bundle/package-inputs.json`](../products/maka/bundle/package-inputs.json), wire its instances and bindings in [`products/maka/bundle/src/composition.ts`](../products/maka/bundle/src/composition.ts), and (for new Rust services) register its factory in [`products/maka/native/src/lib.rs`](../products/maka/native/src/lib.rs).

For standalone third-party plugin authoring, see [`@maka-agent/plugin-sdk`](../packages/plugin-sdk/README.md) and the bundled [`maka-plugin-authoring`](../skills/maka-plugin-authoring/SKILL.md) skill.
