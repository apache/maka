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

Mermaid fences render locally with Pele. `TextView` retains ownership of Markdown; a language extension supplies the diagram view. Maka resolves SVG theme colors and converts labels to vector paths using local fonts on a blocking worker, then uses NSH's existing image loader without changing vendored NSH. Streamed edits are coalesced, source remains available for copying, and syntax errors show their source. Terminals show the code block. Diagram links, external images, and JavaScript callbacks are not enabled. Updates follow display frames and keep only the latest input while a conversion is in flight. Maka disables Pele’s source/output/edge quotas and adds no SVG byte or variable-depth caps; NSH’s existing image-loader constraints still apply.

The crate bundles only the generic `app/Bootstrap.tsx` loader. A shell connects to the Host, admits itself with `host::admit`, creates `bindings::Bindings`, and supplies its viewport, environment and data directory through `configuration`. The bootstrap loads the complete UI selected by the deployment source's `ui: { path, id }`. The default product selects Maka's root, compiled into `app/App.js` in the same immutable package pipeline as other UI plugins. Custom roots own their navigation, layout and interactions; a missing root does not load Maka. The [terminal shell](../terminal-shell/README.md) and [desktop shell](../desktop-shell/README.md) use the same loader and native runtime. On a graphical desktop, the default root uses `app/chrome.ts` to make its top header the title bar and set the application menu.

Side conversations keep their own model, draft and workspace. Conversation-scoped menu actions follow the pane containing native keyboard focus, just like its shortcuts. File and image requests carry their source session into the window's shared workspace preview; opening a resource from another conversation replaces that preview's tabs without changing either conversation. External URLs do not change the preview. The workspace view input lists mounted sessions instead of implicitly selecting the main conversation.

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
  -E 'package(=maka-cli) & binary(=integration) & test(=terminal::keyboard::model_and_source_search_preserves_focus_and_keyboard_selection)'
```

This runs a real Host test; it is not a standalone type generator or a TypeScript check of the application.

The composer shares one collapsible detail area for Goal, Todo, computer access and queued messages, attached to the top edge of the desktop composer card so opening details above the row keeps the toggle in place. Goal details and controls open inline; `/goal` still opens the creation and management dialog. Summaries remain visible while details are closed, and Todo can be hidden for the current checklist until the agent writes a different list; updates do not open a panel or switch the selected one. Switching details preserves queued-message edits. Pending approvals and unresolved-operation recovery remain separate. Completed action feedback disappears after four seconds. Checking an original action only reads its receipt; if no result can be confirmed, dismissing its notice preserves the original record without cancelling or retrying it.

Use **Pin** in a conversation’s action menu to keep it in the **Pinned** group at the top of the browser. **Unpin** returns it to the ordinary list. The Host stores the choice and orders pages consistently across interfaces and restarts.

On the desktop, **Ask beside** under a reply asks a side question about it without adding to the main conversation. It forks the conversation through that reply's turn and opens a card at the right of the main conversation, quoting the passage selected in the reply, if any. The card opens at once and takes the question while the fork is created; one card is open at a time, it closes when another conversation is selected, and **Open as a conversation** shows the side question as a full pane. The card shows only what was asked in it; a full pane folds the conversation it inherited. **Quote for a side question** gathers up to eight passages from several replies to ask about together. Side questions stay out of the sidebar: each reply lists them under **Side questions**, where they can be opened or archived, and the passages they asked about are underlined in the reply and open their side question. A side question is named by its first question and leaves no trace until something is asked in it. The parent's next message carries what its side questions finished since they were last carried (each question and the last answer, truncated), appended to the message text and shown folded under the message; sibling side questions do not see each other. The link between a side question and its parent is kept in session labels (`maka.side:`, `maka.side-quote:`, `maka.side-asked`), a Workbench convention rather than part of the Host protocol.

**Trajectory** shows the conversation's execution records in order, including model attempts that produced only tool calls or failed before emitting text. Select a record to inspect it. Model requests show recorded times, first token latency when available, usage, and context limits. Tool details show the original arguments and results. Click the timeline to jump to a turn or request, drag to filter by time, and zoom in to see shorter spans. Search covers loaded records, including collapsed turns and subcalls, and **Load older records** extends the window.

On the desktop, editing a user message opens an editor in its place and creates nothing until the edit is sent. Sending forks the conversation before that message's turn, opens the fork and sends the edited text there; the original conversation is unchanged. Escape or Cancel closes the editor, and a failed fork keeps the edited text. A message with attachments or references forks at once and puts its text in the fork's composer, where they can be added again.

**Child conversations** in the sidebar action menu opens a separate outline, so deep ancestry does not consume the sidebar. Expand a disclosure arrow to load children, including archived conversations and children in other workspaces; click a title to open that conversation. Branches page through the existing session directory and the outline scrolls horizontally when needed. Creation ancestry comes from `parentSessionId`, independently of fork-source history.

**Settings → Skills** discovers skills from a GitHub `owner/repository`, a Git URL or GitHub subdirectory URL, or a directory on the connected Host. Select the skills and their installation location: global or project `.agents/skills` or `.maka/skills`. Same-named skills resolve in this order: project `.maka`, project `.agents`, global `.maka`, global `.agents`. Cards retain every physical instance and indicate which one is effective. Deleting an override reveals the next instance.

Only skills installed through Maka have an update button. Updating replaces their entire directory from the recorded source, including resources, and overwrites local edits. Other skills in the four standard directories can still be inspected and deleted. The source registry lives in the Host database; no npx lockfile or private copy of the skills is created.

**Settings → MCP servers** manages the four corresponding `mcp.json` files through command/HTTP forms. It preserves other entries and custom fields. Selecting a project does not create a conversation. Downloads, file changes and registrations run on the connected Host; saving a project MCP file does not grant it trust.

**Settings → Connections & models** keeps provider sign-in, connection details and the model list together. A new or edited connection can be saved and signed in with one action. Device sign-in opens the browser and keeps the code, copy controls and cancellation available in the dialog. Model discovery can be retried independently after successful sign-in. Advanced connection and model options stay behind disclosures; saved connections can be reloaded after external changes, and Back asks before discarding edits.

The provider picker separates account sign-in, custom endpoints and named API services, with alphabetical choices within each section. Search accepts multiple terms, supports arrow keys and Enter, and Escape clears the query before returning. Returning from a new connection preserves the provider search and selection; adding another connection suggests an unused ID among the loaded connections.

Built-in subscription, compatible-endpoint and region labels follow the interface language. Provider search matches both the original and localized labels. Saved connection names, brand names, model IDs and reasoning-effort values keep their original spelling.

## Icons

`app/Icon.tsx` keeps the Workbench name API and terminal glyphs. Desktop/Web
uses the selected Lucide data in `app/lucide.ts`, on a 24-point grid with a
two-point round stroke. Play, pause and stop stay filled; unread keeps its
small filled dot. The context gauge, checklist progress pie, turn rail and
choice indicators remain purpose-built data/control drawings.

To regenerate, install the repository's npm tools, extract `lucide-static`
1.61.0 from npm outside the checkout, then run:

```sh
python3 -I products/maka/workbench/scripts/lucide.py /path/to/package/icon-nodes.json
```

The generator checks the input digest and formats its output with the repository's
Biome. Only selected geometry is shipped; there is no Lucide runtime dependency.
Names map in `Icon.tsx` (for example `refresh` → `refresh-cw`, `edit` → `pencil`,
`activity` → `clock`, `nowrap` → `move-right`).
Upstream attribution is recorded in `LICENSE`, `NOTICE` and the source audit.

The Markdown mark retains its M/down-arrow geometry because Lucide has no equivalent.

### Terminal icons

Each entry in `Icon.tsx` pairs a Lucide name with a terminal glyph under the same
Workbench name. Both fields are required, and TypeScript checks the Lucide name
against the bundled geometry. All current names have glyphs; this migration
preserves their characters and the terminal's fixed 16 × 16 layout, which ignores
the graphical `size` prop.

TUI icons remain text. Glyphs are chosen for the action or status rather than
derived from Lucide names: `activity`, `thinking` and `loader` all use `◌`, while
`statusSuccess` uses `✓` without Lucide's enclosing circle. Loading, turn-rail and
choice indicators retain their own terminal text and layout.

No icon font is required; Workbench does not detect fonts or substitute glyphs. Existing emoji
such as folder, file, pin and paperclip depend on the user's terminal font and
cell-width handling; they may differ in appearance from the graphical icons.
For a new icon, add both fields and prefer a recognizable text symbol without
private-use font codepoints. Check it in terminal context for clipping, alignment
and meaning before changing an existing glyph; Lucide has no automatic Unicode
equivalent.

## External agents

Open **Settings → External agents**, or use **External agents** in the model picker. Only Antigravity, Codex and Claude Code are offered; all are off by default. Listing disabled runtimes does not probe them. Each enable requires fresh acknowledgement of native full-access permissions and updates the conversation Agent. Disabling preserves native launch settings and login. With Antigravity enabled, Maka installs its command-title hook in each private invocation and removes it when that invocation closes.

These CLIs retain native tools, accounts and full-access permissions outside Maka’s sandbox. Maka Host tools still use their existing authorization and receipts. Install, initialize and sign in using each native CLI, then **Refresh**. There is no SDK installer or automatic update. Claude runs in an interactive PTY, never print mode.

Expand **Details** for installation, authentication and model diagnostics. Native protocol model discovery shares a bounded cache with single-model validation. An unavailable external runtime does not remove native model choices. Claude uses its native configured default when discovery is unsupported.
