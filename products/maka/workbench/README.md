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

# Maka workbench

The shared NSH client runtime and Maka's default UI package. The native bindings (`src/bindings.rs`) connect trusted UI code to a public Host. [package.ts](package.ts) declares the ordinary `maka.workbench` package, whose `root` contribution is implemented by `app/App.tsx`. Its Markdown uses NSH's `TextView` from `nsh/base`.

The crate bundles only the generic `app/Bootstrap.tsx` loader. A shell connects to the Host, admits itself with `host::admit`, creates `bindings::Bindings`, and supplies its viewport, environment and data directory through `configuration`. The bootstrap loads the complete UI selected by the deployment source's `ui: { path, id }`. The default product selects Maka's root, compiled into `app/App.js` in the same immutable package pipeline as other UI plugins. Custom roots own their navigation, layout and interactions; a missing root does not load Maka. The [terminal shell](../terminal-shell/README.md) and [desktop shell](../desktop-shell/README.md) use the same loader and native runtime. On a graphical desktop, the default root uses `app/chrome.ts` to make its top header the title bar and set the application menu.

Installed UI runs as trusted code in the shared NSH VM, with dynamic JavaScript evaluation and prototype extensions enabled. It can use NSH’s supported HTTP methods, WebSocket, clipboard, file picker and URL opening, registered Host functions, the full Maka native client and its declared services. Raw TCP, process, filesystem and environment access follow NSH’s native API rules.

Generate current NSH and native Host declarations in a new directory, then check the actual application with TypeScript:

```sh
cargo run --locked -p maka-workbench --example ui_types -- /tmp/maka-workbench-types
tsc -p /tmp/maka-workbench-types/tsconfig.json --noEmit --skipLibCheck false
```

The example writes declarations from the same NSH sources and native registry used by UI packages. Its TypeScript project includes `Bootstrap.tsx`, `App.tsx` and the Computer permission components; their real imports are checked too. It does not connect to a Host or open a desktop. Use an unused output directory and a TypeScript compiler compatible with the current `nsh check` toolchain.

The [real Host test fixture](../terminal-shell/tests/real_host/support.rs) writes `host.d.ts` to the directory named by `MAKA_NSH_EVIDENCE`, using `nsh_core::element::declarations` on the actual `maka/host` registry. To collect it from the same model-search test selected by CI, run from the repository root:

```sh
MAKA_NSH_EVIDENCE=/tmp/maka-nsh-evidence cargo nextest run --locked --workspace \
  -E 'package(=maka-cli) & binary(=integration) & test(=terminal::keyboard::connection_filter_preserves_model_search_focus_and_keyboard_selection)'
```

This runs a real Host test; it is not a standalone type generator or a TypeScript check of the application.

The composer shares one collapsible detail area for Todo, computer access and queued messages. Their summaries remain visible while details are closed; updates do not open a panel or switch the selected one. Switching details preserves queued-message edits. Pending approvals and unresolved-operation recovery remain separate, and completed action feedback can be dismissed.

Use **Pin conversation** in a conversation’s action menu to keep it in the **Pinned** group at the top of the browser. **Unpin conversation** returns it to the ordinary list. The Host stores the choice and orders pages consistently across interfaces and restarts.

**Settings → Skills** discovers skills from a GitHub `owner/repository`, a Git URL or GitHub subdirectory URL, or a directory on the connected Host. Select the skills and their installation location: global or project `.agents/skills` or `.maka/skills`. Same-named skills resolve in this order: project `.maka`, project `.agents`, global `.maka`, global `.agents`. Cards retain every physical instance and indicate which one is effective. Deleting an override reveals the next instance.

Only skills installed through Maka have an update button. Updating replaces their entire directory from the recorded source, including resources, and overwrites local edits. Other skills in the four standard directories can still be inspected and deleted. The source registry lives in the Host database; no npx lockfile or private copy of the skills is created.

**Settings → MCP servers** manages the four corresponding `mcp.json` files through command/HTTP forms. It preserves other entries and custom fields. Selecting a project does not create a conversation. Downloads, file changes and registrations run on the connected Host; saving a project MCP file does not grant it trust.
