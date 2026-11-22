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

# Product Bundle

[简体中文](README.zh-CN.md)

`products/maka/bundle/` selects the built-in [plugins](../../../plugins/README.md) and the default [`maka.workbench`](../workbench/package.ts) UI package, compiling them into the baseline deployment embedded in `maka`:

- [`package-inputs.json`](package-inputs.json) — Authored plugin directories included in the product.
- [`src/composition.ts`](src/composition.ts) — Instance graph, service bindings, and stable logical instance UUIDs.
- [`scripts/build.mjs`](scripts/build.mjs) — Bundles `.maka-plugin` archives, NSH UI modules, and `product-version.txt` into `dist/`.

## Installation and upgrades

Default installations store a pinned `maka.product.installation` baseline in `input.base`, user customizations in `overrides`, and standalone plugin additions in `input.instances`. Expanding `base` adds no extra UUID prefix, so conversations and plugin state preserve their identities across product upgrades.

Both Host startup and `maka application update-defaults` advance the baseline pin while keeping explicit user `overrides` intact:

- `configurationFields` records path-level object edits (omitting `value` deletes a field; explicit JSON `null` sets `null`).
- `configuration` replaces whole top-level fields (arrays such as tool lists are replaced as a whole rather than merged by name).
- `remove` disables an inherited baseline instance, and `input.ui` (or `base.ui: null`) overrides the inherited `workbench-ui` root.

## Building and authoring deployments

`maka-cli` embeds the built bundle automatically. To export a standalone bundle directory without compiling `maka-cli`:

```sh
just product --output ~/.cache/maka/product-export
```

To compile a single NSH UI entrypoint or generate a checked deployment directory from an `installation.json` file (without requiring Node.js at runtime):

```sh
maka application build-ui --entry ui/index.tsx --output ui-build
maka application compose --configuration installation.json --output product-source
```

`compose` emits `host.json`, `endpoints.json`, `native-grants.json`, resolved `installation.json` keys, and `.maka-plugin` archives into a fresh directory. Keep the emitted `keys` and `hostDeployment` when re-composing an existing installation so state stays attached to its original owners. Commit and serve an explicit deployment with `maka host init`, `maka application commit`, and `maka application serve` (`--help` lists required flags).

## Verification

```sh
npm --workspace @maka-agent/product run typecheck
npm --workspace @maka-agent/product test
cargo nextest run --locked -p maka-cli --test integration -E 'test(initialize::)'
```
