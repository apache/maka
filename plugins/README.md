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

A plugin is declared by a leaf `package.ts`. It lists executable entries, configuration, imports and exports. A Cargo crate is a compilation unit: one plugin may use several crates, and related plugins may share an implementation crate.

| Family | What it owns |
| --- | --- |
| [agent](agent/README.md) | Conversations, model execution, tools, goals and scheduling |
| [workspace](workspace/README.md) | Files, processes, Web and Jev services |
| [settings](settings/native/README.md) | Connections, credentials and preferences |
| [skills](skills/native/README.md) | Skill discovery, reads and publication |
| [interactions](interactions/native/README.md) | Questions and forms |
| [workhub](workhub/core/README.md) | Task coordination and worker results |
| `application/` | Deployment management, plugin installation and UI authoring |
| `shared/` | Shared TypeScript contracts and authoring helpers |

For an existing plugin, start with its declaration and follow its selected implementation. Native entries select an implementation supplied by the executable; JavaScript entries name their bundled local module. Neither a family directory nor a linked crate activates a plugin.

Packages declare `application.host`, `application.ui`, or a composition template. Each deployment instance selects its entry through `usePackage: host / ui / composition`; a pure UI plugin needs no placeholder Host service. The [terminal shell](../products/maka/terminal-shell/README.md) and [desktop shell](../products/maka/desktop-shell/README.md) run the same [NSH workbench](../products/maka/workbench/README.md), sharing dynamic UI modules and public Host capabilities. A package may declare a `root` contribution to provide the entire application; the deployment source selects it through `ui: { path, id }`. Maka’s default workbench is an ordinary UI package, and a missing root never falls back to it. Installation implies user trust, so UI plugins use the existing workbench capabilities directly.

A UI entry can declare service imports and bind them to Host exports, including its own package's backend. `UiContext.services` calls those providers through the actual UI consumer session; `UiContext.operations` recovers that instance's original mutation receipts. The full `UiContext.host` remains available to trusted code. See the [UI authoring guide](../skills/maka-plugin-authoring/references/ui-plugins.md).

Build a single package from the repository root:

```sh
node scripts/plugins/build.mjs   --plugin plugins/workspace/workspace-web --output /tmp/maka-web-bundle
```

The builder replaces its output directory. It emits immutable-package inputs under `packages/`; inspect one with `maka application inspect-package --package /tmp/maka-web-bundle/packages/workspace-web`.

To include a plugin in Maka, add its path to [the product selection](../products/maka/bundle/package-inputs.json), then add instances and bindings in [the composition](../products/maka/bundle/src/composition.ts). A new native implementation also needs a factory in [the product registry](../products/maka/native/README.md). An import identifies a dependency; Host grants determine which calls are allowed.

The [plugin-authoring skill](../skills/maka-plugin-authoring/SKILL.md) includes a runnable standalone starter and guides for services, UI, state and native extensions. The [SDK](../packages/plugin-sdk/README.md) supplies the exact contracts.

Plugin lists use the package author's `displayName` and `description`. Describe what the user can do in one sentence; internal package IDs remain stable technical identities. Optional `localizations` maps language tags to translated names and descriptions:

```ts
{
  id: 'example.notes',
  displayName: 'Notes',
  description: 'Write and find your notes.',
  localizations: {
    'zh-CN': { displayName: '笔记', description: '记录和查找笔记。' },
  },
  // application: ...
}
```

The plugin manager displays and searches this copy. Missing translations fall back to the default copy, then the instance name or package ID. Labels should predict the action or destination, following [Apple's guidance on clear names](https://developer.apple.com/videos/play/wwdc2026/290/). Use familiar icons with accessible labels and tooltips for common actions; keep explicit text for consequential or unfamiliar actions. Shell lists use their native virtualized controls and preserve the visible row; data cursors remain an implementation detail.
