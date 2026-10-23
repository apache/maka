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

# Maka NSH terminal shell

Runs the experimental [Maka workbench](../workbench/README.md), an Agent workbench built with NSH, in the terminal, with mouse and keyboard interaction, connecting to or starting a Maka Host Root.

NSH lives in [`third-party/nsh`](../../../third-party/nsh/SOURCE.md). Cargo builds the runtime, TSX bundler, `nsh-base` components and UI declaration generator from that source; a separate NSH checkout is unnecessary. Make related NSH and Maka changes in the same tree and validate them together with the terminal's [real Host tests](tests/real_host.rs): `cargo test -p maka-cli --no-default-features --test terminal_real_host`.

## Start

From the workspace root, build the product bundle and start the terminal interface in the Maka CLI:

```sh
npm run build --workspace @maka-agent/product
cargo run -p maka-cli
```

The shell discovers and verifies the selected Root's live Host. If none is running, it uses the same `maka` executable and the existing deployment policy to start one. A separate `host serve` terminal is unnecessary. The default business Host Root is `~/.maka/application/host`; use `--root /path/to/root` to select another.

Installed users can run `maka` or `maka terminal-shell` from the same Maka executable. Use `--root`, `--session` or `--help` to select a Root, open an existing conversation or inspect the options. Relative Root paths use the caller's working directory.

At startup, the shell negotiates image transport and display geometry. On Linux (including WSL), macOS and Windows, the required capabilities enable the entire interface to use GPU-rendered pixel frames through Kitty, Sixel or iTerm2. Otherwise, the same application uses Unicode rendering. Both presentations support mouse and keyboard interaction. Pixel rendering follows the current terminal font density: each terminal row corresponds to 16 logical pixels, while frames retain the full reported device resolution. Resizing or changing terminal font size updates layout and pointer coordinates together.

Kitty pixel frames use one complete upload-and-retirement write with error-only replies. The original writer's flush receipt permits native input publication without waiting for a success reply on every frame; a flush does not prove that the terminal has parsed or displayed the image. Any negative reply for either session-owned image slot ends the graphics session. Resize immediately revokes old pointer geometry while any started write finishes intact.

Without `--session`, the centered composer offers **Choose workspace** before editing. Add `--session SESSION_ID` to open an existing conversation directly. The Host must provide `agent`, `settings` and `receipts`. Exiting closes only the shell's own connection; the Host follows its existing lifecycle and idle policy.

Use **Connections & models** on Home or **Settings** in the sidebar to add a connection and API key, fetch its model catalog or add a model ID manually, and configure supported reasoning efforts and the connection default. These settings can be configured here even with a fresh Host. Choose **Choose workspace** or press Ctrl+N, then choose a directory published by the Host. Within a conversation, a new conversation reuses its authorized workspace. Creation opens **Models** to select the connection, model and effort before sending.

**Sessions** uses a collapsible sidebar when the terminal has room for both it and the conversation; smaller windows use a dialog. Open either with the header's browse button or Ctrl+O. **New conversation** sits above the compact workspace scope, title search and filters; **Settings** sits below the list. Drag the divider or use **‹** / **›** to adjust the sidebar. Choose **All workspaces**, the current session's exact workspace, or a project. A project's **+** creates in its Host-authorized directory. An isolated worktree is not necessarily part of its parent project. Keyboard controls remain available without persistent help rows.

Open **Files** in a conversation header or **Commands** to browse its authorized workspace. Files and current Git changes open in session-owned preview tabs, docked on the right when space allows and in a dialog otherwise. Directory updates retain the already requested range; scrolling automatically requests later pages. Switching conversations closes its previews and watches while preserving the conversation draft.

File previews are captured contents: **Refresh** reads the current file again. Text and image captures preserve complete original bytes; binary files, links and missing files show explicit unavailable states. **Changes** and each diff have their own **Refresh** and describe the current workspace, rather than a turn's deliverables. Diff tabs parse the complete returned patch and split long lines into display rows. Tool-result image tabs continue to use their original retained image.

## Keyboard

| Key | Action |
| --- | --- |
| Ctrl+P | Open **Commands** |
| Ctrl+O | Open **Sessions** |
| Ctrl+G | Open model and effort choices in **Models** |
| Ctrl+N | Create a conversation |
| Ctrl+L | Jump to the latest messages |
| Alt+↑ | Focus the conversation for scrolling |
| Alt+↓ | Open and focus the latest process group (or its flat rows) |
| Tab | Move between controls |
| Enter | Send from the composer, select a search result, or activate the focused control |
| Shift+Enter | Insert a newline in the composer |
| Esc | Go back within **Models**, then close it; otherwise close the overlay or focused browser, or request Stop from the conversation |
| Ctrl+C | Copy selected text through the terminal's OSC 52 support |
| Ctrl+Q | Quit |

Model selection uses **Ctrl+G** because classic terminals encode Ctrl+M as the same carriage return as Enter. Paste through your terminal's paste command.

In a search field, type to search, use ↑/↓ to select, and Enter to activate. Sessions searches titles within the chosen scope, using the complete case-sensitive literal substring. The Host applies this search before paging; it does not search conversation contents, paths or IDs. Model search uses the Host's catalog. Results load automatically as you scroll or move down.

Click the composer's model label or press Ctrl+G to open **Models**, then choose **Model** or **Effort**. Effort choices come from the selected model's published policy; **Off** appears only when supported. **Default · Use connection default** clears an explicit effort override and follows the connection's default. Re-selecting the same model on the same connection preserves an explicit effort choice. Escape or **Back** returns from either list to the menu; another Escape or **Close** closes it and restores focus to the opener, preserving the draft and caret.

## Conversation and requests

Earlier messages load automatically as you scroll up, preserving your reading position. Continuous thinking and tool activity form process groups; an intermediate reply or incoming message starts a new group. Replies appear outside these groups, and the final answer appears once. Completed turns fold their work by default. Stopped, failed and interrupted turns, and turns with interleaved input, keep their work available. Completion and final-answer placement use the Host's recorded turn metadata.

Work uses one presentation: live activity stays in its own scrollable panel, with the latest thinking or tool activity in its header. Completed turns fold automatically and keep the final answer outside the panel. Expand or collapse a turn or its work details whenever needed.

Grouped activity has independent native scrolling, capped at half the reading viewport. A newly opened live group starts at the bottom, while a closed group starts at the top. An already open reader stays in place as the group closes. Scrolling up keeps your source reader in place when later replies arrive. Thinking disclosure and Source choices remain attached to their original rows across updates. Tool details load on demand from the Host; a layout change can reload their original source.

Assistant responses format headings, emphasis, lists, quotes, tables and code. Each code block has its own **Copy code** action. **Show message source** switches to the exact selectable text; **Show formatted message** restores formatting. Partial history stays literal until its opening is loaded.

Markdown images render inline from the conversation's workspace or an HTTP(S) URL. Workspace images use the existing Host file reader; network images load on the client through NSH's native image loader and cache. The application grants HTTP(S) GET, including the same permission check on each redirect. Activate an unlinked image to view it full screen, then close or press Escape to return to that image without changing the draft; linked images keep their original link target. Loading and failures have explicit captions, with retry available on an unlinked failed image. Source mode and message copy preserve the original Markdown.

**Todo** sits above the composer and displays the Agent's actual checklist, including its current item and completed count. Token speed reports the **last request**; context figures mark approximate or last-known values. Unavailable metrics are omitted.

User messages offer **Copy user message** once recorded by the Host. Completed replies offer **Copy message**, **Fork from this turn** and **View this turn's model usage**, alongside the original-source toggle and recorded model and duration. These compact icon actions remain available with descriptive tooltips and accessible labels. Both message copy actions read the complete original message even when only its history tail is visible. Fork copies history through that reply's completed turn into an independent conversation and keeps the source draft with its owner; an earlier completed turn can be forked while a later turn is running. Usage reads the original turn's recorded main-model requests, with separate input, output, reasoning, cache and recorded-cost fields. Missing counters and prices remain unavailable. Copied and imported history does not acquire new physical model charges.

The activity header follows the latest thinking, streamed tool arguments or running tool. A request waiting for your response takes priority. Long titles shorten at complete Unicode characters, and title updates preserve your position in the activity reader.

Expand a tool result containing an image to see its thumbnail, then activate **Open image** for a larger preview. Escape or **Close** returns to the conversation and restores focus without stopping the run. Both views use the original image retained by the Host, even if its workspace file changes. In Unicode presentation, inline images use Sixel when support and measured cell pixels are available, or colored Unicode half and quadrant blocks otherwise. Resizing invalidates the old measurements: images temporarily use Unicode while the original query replies drain, then restore Sixel when a fresh query completes. Waiting for a terminal reply does not block Unicode rendering or input. Unsupported image formats show an error in the result.

Open a pending request to review its original details:

- Tool approval supports **Allow** or **Deny** for that call. Read all original arguments before allowing.
- Additional permissions support **Allow** or **Deny**, with the available call, turn or session scope.
- Questions support the listed choices, **Other answer** and an explicit **Skip**.
- Forms let you edit and submit the requested fields, with validation and masked sensitive values, or explicitly **Decline** or **Cancel request**.
- Computer-access requests show the original target and boundary before an explicit allow or deny decision.

Use Tab to move between request controls and Enter to activate. For approvals, permissions and questions, Ctrl+Enter allows or submits answers; Ctrl+R refreshes the recorded status. Escape only closes the request view and leaves an unanswered request pending. The displayed recorded outcome is authoritative if another client answered first.

## Saved state and scope

Drafts and operation receipts persist in `<root>/clients/terminal.sqlite`. Each session keeps its own draft, and recovery uses the original Host and operation. Switching conversations saves the current draft first. Recovery starts from the latest acknowledged draft revision; newer unsaved input can be lost on close. A send uses that saved revision. Use the original-operation recovery action for an uncertain result, rather than submitting a duplicate.

The executable verifies the selected Root and live Host epoch. Ctrl+Q, and SIGTERM on Unix, request shutdown independently of JavaScript and terminal output. Shutdown attempts terminal restoration and closes owned Host requests and tasks; incomplete cleanup returns an error.
