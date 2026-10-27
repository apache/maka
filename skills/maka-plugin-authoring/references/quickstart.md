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

# Build a plugin

## In this repository

Choose the owning family under `plugins/`. Each plugin's `package.ts` exports a manifest whose `application` can contain a `host`, a `ui`, a `composition`, or a combination of them. Native Host entries use `sdk.nativeImplementations`; JavaScript Host entries declare their local module, configuration, imports and exports.

Build an existing leaf from the repository root:

```sh
node scripts/plugins/build.mjs --plugin plugins/workspace/workspace-web --output ./maka-web-bundle
maka application inspect-package --package ./maka-web-bundle/packages/workspace-web
```

The builder replaces its output directory. For a product feature, add the package to `products/maka/bundle/package-inputs.json` and its instances to `src/composition.ts`. Installed plugins can be added or updated through the connected Host's management service without rebuilding the client.

## Standalone starter

Copy `create.mjs`, `host.mjs` and `ui.tsx` from `assets/starter/` together. Then run:

```sh
node create.mjs --output ./my-plugin --target ui --maka /path/to/maka
```

The output directory must be new. `--target ui` builds an NSH counter application with root, panel and command contributions; `--target host` creates an Echo service. The helper writes a checked package and a small composition containing its instance. Its UI composition selects the example root. It does not replace or start an installed business Host.

For UI, the helper calls `maka application build-ui --entry ui.tsx --output DIRECTORY`. That command writes a self-contained module, staged assets and `manifest.json`. Copy its `module` to the package's declared UI module and each asset's `file` to its relative `path` beside that module before computing the package reference.

The generated manifest uses `schemaVersion: 1`, `application.host` or `application.ui`. The composition contains `instances` and an optional `ui: { path, id }` root selector; each node selects `usePackage: "host"`, `"ui"` or `"composition"`. A package may provide both Host and UI entries, selected by separate instances in the same source. Declare UI service imports in `application.ui.imports` and bind them to the chosen Host exports through the UI instance's `bindings`; `context.services` calls those providers with the UI consumer's identity and original mutation receipts. The full trusted `context.host` remains available. A pure UI package needs no dummy Host service.

Install the package into the connected Host, then insert and enable its UI instance. Keep the current root to use the counter panel and command within that application; select the example's `root` contribution in the composition's `ui` field to use the counter as the complete client application. Use the generated composition as a checked example rather than replacing unrelated business instances. [Runtime UI authoring](runtime-ui.md) describes the management tools.

Keep the composition outside the package so the package digest cannot refer to itself. Recompute references after package bytes change and preserve instance UUIDs when updating saved data.
