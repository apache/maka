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

This directory selects the Host and UI plugin packages shipped with Maka and binds them into one Agent source. Plugin declarations and implementations live under [plugins](../../../plugins/README.md) and [the default workbench package](../workbench/package.ts).

- [package-inputs.json](package-inputs.json) selects authored packages.
- [src/composition.ts](src/composition.ts) builds instances, bindings and installation identities.
- [scripts/build.mjs](scripts/build.mjs) emits package bytes and authoring code into `dist`.

## Installation and upgrades

Default installations persist a pinned `maka.product.installation` composition in `input.base`, its user `overrides`, and independent roots in `input.instances`. The immutable baseline package contains the generated defaults and their installation inputs (including stable logical instance identities). It is not a second editable deployment. Root expansion adds no structural instance or UUID namespace, so existing conversations and plugin state keep their identities.

Startup and `application update-defaults` preview/apply use the same checked source update. Upgrades replace the baseline pin while retaining explicit overrides. The runtime does not recognize or automatically convert legacy flat default installations: migrate those explicitly with [the one-time external migration tool](https://gist.github.com/M4n5ter/407366c4943e412e84d06dad3a1c3643/058b24ca4c7450e4e3e5cb2fd882e4b8b00284e3#file-readme-md) before starting the new version. Explicitly authored flat deployments retain their selected-package update behavior and never opt into a product baseline automatically.

Configuration overrides can record exact `configurationFields` object paths. An omitted field `value` means deletion; JSON `null` remains a value. Existing `configuration` overrides still replace whole top-level fields. Arrays, including tool lists, are explicit whole selections, not lists merged by display name. Independent additions and complete component substitutions retain their chosen packages and configuration. Source editing records these decisions at their original owner; it never saves a materialized default graph. See the [composition types](../../../platform/plugin-core/src/composition.rs) and [root composition](../../../platform/plugin-core/src/composition/root.rs).

The template may supply the default root UI. `input.ui` explicitly selects another root; `base.ui: null` explicitly disables the inherited root. Package, configuration and binding conflicts reject the candidate before persistence. Applied operations freeze their exact source and package bytes for recovery instead of reauthoring against a newer executable.

Baseline publication metadata describes defaults; it does not grant access. Existing native grants and explicitly narrowed publications remain authoritative. Endpoint names tagged in `productMethods` retain their explicit follow-contract policy.

## Model discovery and child conversations

The default installation exposes `ModelList`, backed by the Agent’s source-aware directory of native models and enabled executor runtimes. Start with `{ "kind": "start", "query": "..." }` (query is optional). Pass a choice’s tagged `selection` as `SessionCreate` / `SessionSend` `backend`; its source-specific thinking levels are not interchangeable. Continue with `{ "kind": "continue", "revision": page.revision, "cursor": page.next }`; restart on `changed`. Catalog availability is not an execution or permission grant and does not guarantee reachability, credentials or quota. `SessionContinueRun` accepts an eligible terminal native-model Run (completed, failed or cancelled), with `model: { connectionId, modelId }` from a `ModelList` `kind=model` choice and optional native `thinkingLevel`, not a tagged executor/backend selection. It uses the exact `sourceRunId` and `sourceHighWater` from `SessionExecution` to admit a new continuation Run after the original effects and cleanup are reconciled; it never resumes an old process or replays the original request.

The sidebar conversation menu opens **Child conversations** in a separate, window-sized dialog. Disclosure arrows load direct children across workspaces, including archived conversations; titles open the requested conversation. The outline uses immutable `parentSessionId` creation ancestry, not fork-source history. Deep trees scroll horizontally and long branches page through the existing session directory.

### Native external execution

Enable individual CLIs in `agent.external.runtimes` (the Agent instance’s `external` configuration), for example `{ "runtimes": { "codex": true } }`. The only runtime IDs are `antigravity`, `codex` and `claude`. Omitted or `null` configuration and unselected runtimes do not launch external processes. `external.commands` can override each CLI’s executable, arguments and environment. Install and sign in through the native CLI; Maka does not bundle an agent SDK, install or migrate credentials.

The built-in `external` executor directly uses agy ACP, the shared Codex managed app-server daemon and Claude Code’s interactive PTY. Codex requires native `app-server daemon start` / `app-server proxy` support: existing daemons are reused, missing daemons are started idempotently, and Maka never stops or restarts the shared server. Each invocation connects independently and cancels only its own turn, awaiting a correlated terminal; it does not create a private app-server. agy and Claude launch with `--dangerously-skip-permissions`; Codex uses `never` approval and full-access sandbox settings. Claude never uses `-p`/`--print`, including discovery, and there is no silent execution fallback. Unsupported setup or native capabilities fail explicitly. These CLIs retain native tools and permissions outside the Maka sandbox; Host tools retain Maka’s captured authorization, receipt and cleanup rules.

For example:

```json
{
  "kind": "executor",
  "selection": {
    "executor": "external",
    "settings": { "runtime": "codex", "model": "gpt-6-luna", "thinkingLevel": "high" }
  }
}
```

Model and effort metadata comes from native protocols, not Settings connections. Claude exposes its configured native default; no headless discovery helper is launched. External discovery failures do not discard native-model choices. Catalog reads and individual-model checks share one bounded cache; Refresh invalidates it. Discovery uses the Agent’s first configured workspace root.

A native session ID and its running fence are persisted before submitting the prompt. Consecutive invocations resume that exact session; switching sources supplies only missing canonical readable history (up to 8 MiB of readable text / 64 MiB of encoded source), with explicit gaps and no historical tool replay, thinking or attachment payload replay. The executor reads only the current `maka.agent.external` journal format. Storage and configuration migration is an offline operation, not an activation-time compatibility path.

Follow-ups are durably admitted through Maka’s editable queue. Active Codex and Claude turns accept steering by default; on Unix, Antigravity soft-interrupts and resumes the same native conversation in a new Host invocation after the original operations and process settle. Explicit `delivery: "queue"` never interrupts. Stop closes Host-tool admission, requests cancellation, drains original admitted operations, then confirms native process and output settlement. Silence, a Stop hook, EOF or exit code zero does not prove success. Claude’s current-turn JSONL completion record is checked together with API error markers. Unconfirmed cleanup never authorizes automatic prompt replay.

Current uploads support UTF-8 text/JSON and PNG/JPEG/GIF/WebP images where the native model supports them. Claude’s interactive PTY pastes immutable image paths and waits for native image acknowledgements; Antigravity receives ordered paths and media types.

MCP addresses and private configuration paths remain stable across invocations within a Host activation. Definitions are immutable within each invocation and can refresh after settlement. Setup runs once; unchanged instructions are not repeated, while changes or removal are delivered explicitly before the next task. Each invocation still has fresh credentials, its own permissions and original operation receipts. Host restart rebinds the local endpoint without repeating completed bootstrap. Windows launch commands must use a native `.exe` or explicit `node.exe` plus CLI-script arguments; `.cmd`/`.bat` shims are not supported.

## Run and develop

From the repository root:

```sh
just run
just run --root /path/to/business-host
```

`just run` opens the [NSH terminal workbench](../terminal-shell/README.md), using `~/.maka/application/host` by default. It connects to an existing Host or starts one automatically. Authoring commands below generate and manage plugin compositions independently of this terminal interface.

The terminal and desktop shells load the same selected NSH root UI. One deployment source manages Host services, UI plugins and composition nodes. UI packages can provide the complete application root, commands, panels, settings pages and tool result components. Installation implies user trust: plugins use the shared VM and existing client capabilities directly. [Selected-package updates](../cli/README.md#product-updates-recovery-and-url-installation) preserve the existing Host source, root selection and native grants.

UI instances can bind declared service imports to Host providers in this source. Their `UiContext.services` and `operations` use the UI consumer's captured session and original receipts, while the full trusted `UiContext.host` remains available. A package can ship its backend and UI together without publishing a separate client endpoint for each private service.

Every CLI build embeds the current TypeScript bundle, including debug builds. Rebuild the CLI after changing plugin sources. `just product` builds the lightweight `maka-ui-build` tool and exports a separate bundle for inspection, without building the product CLI. Editing that exported bundle does not change the embedded resources. The build generates `product-version.txt` from exact authoring and named package bytes. Installation and updates validate real package bytes against this identifier. Treat the bundle output as a generated artifact: rebuild after source changes instead of editing output files. Missing, malformed or mismatched identifiers require a rebuild. Use a separate output directory when building an artifact alongside a running development build:

```sh
just product --output ~/.cache/maka/product-export
```

UI entries are compiled with the NSH compiler into self-contained ES modules, with their assets in the same immutable package. Cargo discovers the declared UI sources and invokes the compiler directly; it does not start a nested Cargo build. `just product` and the workspace npm build/test commands pass the exact compiler executable reported by Cargo. The standalone Node plugin package builder also builds this lightweight tool when UI compilation is needed. `MAKA_UI_BUNDLER` can select an already-built `maka-ui-build` executable.

To compile one NSH UI module directly:

```sh
maka application build-ui --entry ui/index.tsx --output ui-build
```

Imported resources use paths relative to the NSH app directory (`nsh.json`, or the directory containing `App.tsx`). For shared assets outside that directory, pass `--asset-root /path/to/source-root`; every imported resource must be inside that root.

The emitted `manifest.json` describes `bundle.js`, assets and source dependencies. The package builder copies them to `application.ui.module` and the corresponding package-relative asset paths.

The default product selects the ordinary `maka.workbench` UI package at `workbench-ui`, with `ui: { path: ["workbench-ui"], id: "root" }` in `host.json`. Its declared imports bind to the selected Agent, settings and other product services. The package builder compiles `app/App.tsx` to the declared `app/App.js` entry through the same UI compiler used by other packages.

## Author an installation

The CLI can produce checked sources and packages without Node at runtime:

```sh
maka application compose --configuration installation.json --output product-source
```

The output directory must be new. The command writes `host.json`, `endpoints.json`, `native-grants.json`, resolved `installation.json` identities and `.maka-plugin` packages. It does not start or install them.

`installation.json` selects `locale` and service configuration. It uses the generated `AgentConfiguration`. Optional services and ACP executors are selected explicitly. See [the configuration](src/composition.ts) and [SDK types](../../../packages/plugin-sdk/src/generated/runtime.ts) for accepted fields.

Preserve the emitted `keys` and `hostDeployment` when reauthoring an installation. They identify existing owners and data. Package revisions identify bytes and can change independently.

For a different application, include its UI package as an instance with `usePackage: "ui"` and set the source’s `ui` selector to that instance path and its declared `root` contribution ID. This selects the entire application, including navigation, layout and interactions. The default Maka root is chosen when first authoring a product source; installation, updates and startup preserve the saved selector. A source without a root has no UI; the shell does not substitute Maka. A custom root can run with a custom Host that has no Agent service.

For explicit installation, initialize the target Host Root with `maka host init`, then commit `host.json` using `maka application commit`. Supply the selected deployment ID, expected revision and exported packages. The generic source commands also support custom plugin compositions independently of this product author. Each command's `--help` lists its required arguments.

Committing stores desired source and bytes; it does not activate or select that deployment. Use `maka application serve` with the emitted `hostDeployment`, `--endpoints product-source/endpoints.json` and `--native-grants product-source/native-grants.json`; `--help` lists the remaining arguments. `maka --root HOST_ROOT` and `maka desktop --root HOST_ROOT` use the Host Root's saved selection.

## Verify changes

```sh
npm --workspace @maka-agent/product run typecheck
npm --workspace @maka-agent/product test
```

The npm tests check complete Host/UI packages and tool presentation declarations using the lightweight compiler. `cargo test --locked -p maka-cli --test integration product_composition::` checks business composition through the actual CLI, without Node at runtime. Native rendering, focus and input changes belong to their shell tests.

## Reusable subagents in conversation

For example, ask: “Create a reusable Reviewer role for code review, using my local connection and llama3.2. Its instruction is: report defects with file and line references.” If the connection or model is ambiguous, resolve it with `ModelList` before saving. `SubagentPresetCreate` returns the actual saved configuration and stable ID; the initial catalog is empty. Only an explicit request to save or change a role persists configuration.

Next ask: “Use Reviewer to review this branch; focus on cancellation for this task.” Discover the role through `SubagentPresetList`, select an available entry by name and description, and pass its ID as `SessionCreate.presetId` without `backend`. Send the current task and context through `SessionSend`, omitting `backend` to preserve the role model. Description helps select a role, instruction guides execution, and the task carries one-off requirements. Full instructions are read on demand with `SubagentPresetRead`, not injected into every parent turn. An unavailable explicit role produces a specific error; without an explicit role, ordinary delegation remains available.

Finally ask: “For future Reviewer tasks, change only the output instruction to a Markdown defect list.” Read its revision and use `SubagentPresetUpdate` with only `id`, `expectedRevision` and `instruction`; an empty string clears it. Use `enabled` to disable/enable, or `SubagentPresetDelete` to delete the requested role. Existing sessions retain their snapshots. Disabled or invalid roles remain readable and repairable. On conflict, re-read and reconcile; only `saved`/`deleted` confirms a mutation. Recover unknown outcomes using the original operation receipt rather than issuing a new mutation or task. Presets do not grant tools, permissions or delegation capabilities.
