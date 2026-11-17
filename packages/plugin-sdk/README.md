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

# `@maka-agent/plugin-sdk`

[简体中文](README.zh-CN.md)

TypeScript contracts and authoring helpers for Maka Host services and shared NSH workbench UI plugins. Bundle guest code before shipping it to the runtime.

| Module | Contents |
| --- | --- |
| [`src/index.ts`](src/index.ts) | `HostService`, `RequestContext`, and top-level SDK exports |
| [`src/workbench.ts`](src/workbench.ts) | NSH UI plugin `activate(context)`, contribution descriptors, `UiContext`, and `UiRuntime` |
| [`src/workbench-views.ts`](src/workbench-views.ts) | Shared view contracts for navigation, conversations, previews, and settings |
| [`src/composer-view.ts`](src/composer-view.ts) | Replaceable composer view contract and resident session controller interface |
| [`src/workspace-view.ts`](src/workspace-view.ts) | Workspace file/diff preview contracts and action handles |
| [`src/generated/runtime.ts`](src/generated/runtime.ts) | Generated Rust wire types and deployment schemas |
| [`src/generated/methods.ts`](src/generated/methods.ts) | Typed Host RPC method inputs and outputs |
| [`src/contracts.ts`](src/contracts.ts) | JSON Schema catalog exported from [`tools/schema`](../../tools/schema/Cargo.toml) |

## UI contributions and live reload

- **Service bindings** — `context.services[importName][index]` invokes declared Host imports under the UI instance's captured identity, while `context.operations` tracks and recovers its two-phase mutation receipts. Trusted UI code can also access `context.host` directly.
- **Typed embedded views** — Declare `{ kind: 'view', contract }` with `defineUiViewContract<Input>(id)` and mount providers via `runtime.renderView(target, contract, input, options?)`.
- **Commands** — Implement `run({ sessionId, argument? })` and optional `enabled(context)`, declared with `title`, `shortcut`, `trigger`, and `takesArgument` metadata.
- **Hot-reload handoff** — Optional `prepareReload()` returns serializable JSON before a VM reload; the replacement activation with the same `(instance, packageId)` receives it in `context.restored` while keeping its live Host client and pending operation receipts.

## Regenerating contracts

After changing Rust wire types (`schemars`), regenerate and verify the SDK from [`maka-schema`](../../tools/schema/Cargo.toml) without building V8 or `maka-cli`:

```sh
npm --workspace @maka-agent/plugin-sdk run schema:generate
npm --workspace @maka-agent/plugin-sdk run schema:check
```

See [plugins](../../plugins/README.md) and the [`maka-plugin-authoring`](../../skills/maka-plugin-authoring/SKILL.md) skill for runnable examples.
