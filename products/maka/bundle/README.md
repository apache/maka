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

# Product bundle

[简体中文](README.zh-CN.md)

This directory selects the business Host packages shipped with Maka and binds them into one Agent/WorkHub source. Plugin declarations and implementations live under [plugins](../../../plugins/README.md).

- [package-inputs.json](package-inputs.json) selects authored packages.
- [src/composition.ts](src/composition.ts) builds instances, bindings and installation identities.
- [scripts/build.mjs](scripts/build.mjs) emits package bytes and authoring code into `dist`.

## Run and develop

From the repository root:

```sh
just run
just run --root /path/to/business-host
```

`just run` opens the [NSH terminal workbench](../terminal-shell/README.md), using `~/.maka/application/host` by default. It connects to an existing Host or starts one automatically. Authoring commands below generate and manage plugin compositions independently of this terminal interface.

The terminal and desktop shells connect to this same business Host. They author their own interfaces; the bundle does not install a presenter or a separate management Host. [Selected-package updates](../cli/README.md#product-updates-recovery-and-url-installation) preserve the existing Host source and native grants.

Every CLI build embeds the current TypeScript bundle, including debug builds. Rebuild the CLI after changing plugin sources. `just product` produces a separate bundle for inspection and export; it does not replace resources inside an existing binary. The build generates `product-version.txt` from exact authoring and named package bytes. Installation and updates validate real package bytes against this identifier. Treat the bundle output as a generated artifact: rebuild after source changes instead of editing output files. Missing, malformed or mismatched identifiers require a rebuild. Use a separate output directory when building an artifact alongside a running development build:

```sh
node products/maka/bundle/scripts/build.mjs --output ~/.cache/maka/product-export
```

## Author an installation

The CLI can produce checked sources and packages without Node at runtime:

```sh
maka application compose --configuration installation.json --output product-source
```

The output directory must be new. The command writes `host.json`, `endpoints.json`, `native-grants.json`, resolved `installation.json` identities and `.maka-plugin` packages. It does not start or install them.

`installation.json` selects `locale` and service configuration. It uses the generated `AgentConfiguration`; an optional `coordinator` adds the WorkHub service to the same Host. Optional services and ACP executors are selected explicitly. See [the configuration](src/composition.ts) and [SDK types](../../../packages/plugin-sdk/src/generated/runtime.ts) for accepted fields.

Preserve the emitted `keys` and `hostDeployment` when reauthoring an installation. They identify existing owners and data. Package revisions identify bytes and can change independently.

For explicit installation, initialize the target Host Root with `maka host init`, then commit `host.json` using `maka application commit`. Supply the selected deployment ID, expected revision and exported packages. The generic source commands also support custom plugin compositions independently of this product author. Each command's `--help` lists its required arguments.

Committing stores desired source and bytes; it does not activate or select that deployment. Use `maka application serve` with the emitted `hostDeployment`, `--endpoints product-source/endpoints.json` and `--native-grants product-source/native-grants.json`; `--help` lists the remaining arguments. `maka --root HOST_ROOT` and `maka desktop --root HOST_ROOT` use the Host Root's saved selection.

## Verify changes

```sh
npm --workspace @maka-agent/product run typecheck
npm --workspace @maka-agent/product test
MAKA_PRODUCT_CLI_CHECK=1 npm --workspace @maka-agent/product test
```

Tests build once, then check Host package declarations, business composition and the shared SDK scene schemas. Setting `MAKA_PRODUCT_CLI_CHECK` also checks packages and compositions against the actual CLI. Native rendering, focus and input changes belong to their shell tests.
