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

NSH lives in [`third-party/nsh`](../../../third-party/nsh/SOURCE.md). Cargo builds the runtime, TSX bundler, `nsh-base` components and UI declaration generator from that source; a separate NSH checkout is unnecessary. Make related NSH and Maka changes in the same tree and validate them together with the terminal's [real Host tests](tests/real_host/mod.rs): `cargo test -p maka-cli --no-default-features --test integration terminal::`.

## Start

From the workspace root, start the terminal interface in the Maka CLI. Cargo builds and embeds its plugins and workbench:

```sh
cargo run -p maka-cli
```

The shell discovers and verifies the selected Root's live Host. If none is running, it uses the same `maka` executable and the existing deployment policy to start one. A separate `host serve` terminal is unnecessary. The default business Host Root is `~/.maka/application/host`; use `--root /path/to/root` to select another.

Installed users can run `maka` or `maka terminal-shell` from the same Maka executable. Use `--root`, `--session` or `--help` to select a Root, open an existing conversation or inspect the options. Relative Root paths use the caller's working directory.

At startup, the shell negotiates image transport and display geometry. On Linux (including WSL), macOS and Windows, the required capabilities enable the entire interface to use GPU-rendered pixel frames through Kitty, Sixel or iTerm2. Otherwise, the same application uses Unicode rendering. Both presentations support mouse and keyboard interaction. At 100% interface scale, pixel rendering follows the current terminal font density: each terminal row corresponds to 16 logical pixels, while frames retain the full reported device resolution. Resizing or changing terminal font size updates layout and pointer coordinates together.

In **Settings → General**, **Interface scale** previews a preset or a percentage entered with Enter. **Save** keeps the chosen scale; **Reset to 100%** previews 100%, and **Cancel** or leaving the page restores the saved scale. Ctrl+0 or Ctrl+Alt+0 resets and saves 100% (Cmd+0 or Cmd+Alt+0 on macOS). Pixel layout and text are rasterized again at the new scale. For Unicode rendering, use your terminal’s font size.

Input, CPU layout, painting and GPU command encoding remain on the native UI path. Owned GPU commands move to the existing background executor, where submission and readback run in one task. The next scene waits until that readback completes, keeping GPU resource writes and polling in order. Image encoding and terminal output can still overlap native work and rendering of later frames; capture does not wait for the preceding terminal acknowledgement.

Kitty prepares complete lossless snapshots while GPU rendering continues. The sole writer selects the alternate image slot after the preceding receipt, retains the acknowledged image underneath, and publishes only after both a complete flush and the matching success reply. Waiting snapshots can coalesce; a started transaction finishes intact. These receipts do not prove display vsync. Any negative reply for either session-owned slot ends the graphics session. Resize immediately revokes old pointer geometry.

Adjacent unpressed mouse moves with the same modifiers coalesce to the latest position. Clicks, drags, wheel events, keys and IME events retain their order and separate those move sequences.

Without `--session`, the centered composer offers **Choose workspace** before editing. Add `--session SESSION_ID` to open an existing conversation directly. The default Maka root UI requires `agent`, `settings` and `receipts`; a custom root uses its own declared services and can run without Agent. Exiting closes only the shell's own connection; the Host follows its existing lifecycle and idle policy.

Use **Connections & models** on Home or **Settings** in the sidebar to add a connection and API key, fetch its model catalog or add a model ID manually, and configure supported reasoning efforts and the connection default. These settings can be configured here even with a fresh Host. Choose **Choose workspace** or press Ctrl+N, then choose a directory published by the Host. Within a conversation, a new conversation reuses its authorized workspace. Creation opens **Models** to select the connection, model and effort before sending.

**Choose workspace → Manage locations** adds or removes named folders using absolute paths on the connected Host. Save the list to keep it across restarts and executable updates. Removing a location does not delete its files. Folders that cannot be opened are omitted from the picker.

**Settings → General** also provides scrollable multiline editors for the assistant’s global **AGENTS.md** and the compaction prompt. Save to apply document edits; **Use default prompt** selects the Host default for the compaction prompt.

The conversation actions menu also provides **Compaction prompt** for a persistent conversation override. The editor opens with the complete effective text; **Use global settings** restores inheritance and displays the global prompt. Newly accepted work and manual compaction use this preference, while already accepted work retains its captured settings; the manual compaction dialog can still override it for one invocation.

The header provides the sidebar toggle and **Commands** (Ctrl+P). The sidebar toggle uses a neutral icon at rest and shows the expand or collapse direction on hover or keyboard focus. Open **Search conversations** from the sidebar or with Ctrl+O to search titles and message contents across readable conversations, including archives.

**Sessions** uses a collapsible sidebar when the terminal has room for both it and the conversation; smaller windows use a dialog. **New conversation** sits above the compact workspace scope, conversation search and filters; **Settings** sits below the list. Drag the divider to adjust the sidebar. Choose **All workspaces**, the current session's exact workspace, or a project. A project's **+** creates in its Host-authorized directory. An isolated worktree is not necessarily part of its parent project. Keyboard controls remain available without persistent help rows.

Open **Files** in a conversation header or **Commands** to browse its authorized workspace. Files and current Git changes open in session-owned preview tabs, docked on the right when space allows and in a dialog otherwise. Directory updates retain the already requested range; scrolling automatically requests later pages. Switching conversations closes its previews and watches while preserving the conversation draft.

File previews are captured contents: **Refresh** reads the current file again. Text and image captures preserve complete original bytes; binary files, links and missing files show explicit unavailable states. **Changes** and each diff have their own **Refresh** and describe the current workspace, rather than a turn's deliverables. Diff tabs parse the complete returned patch and split long lines into display rows. Tool-result image tabs continue to use their original retained image.

## Keyboard

| Key | Action |
| --- | --- |
| Ctrl+P | Open **Commands** |
| Ctrl+O | Open **Search conversations** |
| Ctrl+G | Open model and effort choices in **Models** |
| Ctrl+N | Create a conversation |
| Ctrl+L | Jump to the latest messages |
| Alt+↑ | Focus the conversation for scrolling |
| Alt+↓ | Open and focus the latest process group (or its flat rows) |
| Tab | Move between controls |
| Enter | Send from the composer, select a search result, or activate the focused control |
| Shift+Enter | Insert a newline in the composer |
| Esc | Go back within **Models**, then close it; otherwise close the overlay or focused browser, or request Stop from the conversation |
| Ctrl+C | Copy selected text; otherwise clear an idle draft with undo, confirm stopping a running task, or press twice to exit while idle |
| Ctrl+0 or Ctrl+Alt+0 | Reset and save the pixel interface scale to 100% |
| Ctrl+Q | Quit |

Model selection uses **Ctrl+G** because classic terminals encode Ctrl+M as the same carriage return as Enter.

Drag files into the message composer, or paste their absolute paths, to add attachments. File URLs, shell-quoted paths with spaces, and Windows paths under WSL are accepted. Ordinary text pastes into the current selection and remains undoable. Paste images or copied files with **Ctrl+V** when the terminal forwards that shortcut; **Alt+V** and **Ctrl+Alt+V** also read the system clipboard directly. Uploads retain their original conversation when you switch conversations, and the resulting attachments use the same saved drafts as files added through **+**.

Type in **Search conversations**, use ↑/↓ to select, and Enter or a mouse click to open a result. Terms match literal substrings with Unicode normalization and case-insensitive OR matching. History uses a persistent SQLite FTS5 index maintained with the original messages. Changing the query or closing search cancels the old subscription. Results show a highlighted preview around the match and open its original message; title matches open the conversation at its latest messages. Search does not read thinking or follow the sidebar workspace and archive filters. Model search uses the Host's model catalog and loads later pages automatically.

Click the composer's model label or press Ctrl+G to open **Models**, then choose **Model** or **Reasoning effort**. Effort choices come from the selected model's published policy; **Off** appears only when supported. A known default selects its actual level directly, without a separate Default row. If the provider controls an unknown default, no level is invented; after choosing an explicit level, **Use provider settings** clears that override. Re-selecting the same model on the same connection preserves an explicit effort choice. Escape or **Back** returns from either list to the menu; another Escape or **Close** closes it and restores focus to the opener, preserving the draft and caret.

The same model menu’s **Code Mode · Apply Patch** opens the current model’s settings directly. **Code Mode** controls tool-call execution; **Apply Patch** independently chooses patch editing or structured edit/write tools. Each supports the model’s default policy or an explicit enabled/disabled override. Choose **Save model** to apply changes to newly submitted messages.

## Conversation and requests

Earlier messages load automatically as you scroll up, preserving your reading position. Continuous thinking and tool activity form process groups; an intermediate reply or incoming message starts a new group. Replies appear outside these groups, and the final answer appears once. Completed turns fold their work by default. Stopped, failed and interrupted turns, and turns with interleaved input, keep their work available. Completion and final-answer placement use the Host's recorded turn metadata.

Work uses one presentation: live activity stays in its own scrollable panel, with the latest thinking or tool activity in its header. Completed turns fold automatically and keep the final answer outside the panel. Expand or collapse a turn or its work details whenever needed.

Grouped activity has independent native scrolling, fitted within half the window height and the available conversation space. A newly opened live group starts at the bottom, while a closed group starts at the top. An already open reader stays in place as the group closes. Scrolling up keeps your source reader in place when later replies arrive. Thinking disclosure and Source choices remain attached to their original rows across updates. Tool details load on demand from the Host; a layout change can reload their original source.

Assistant responses format headings, emphasis, lists, quotes, tables and code. Drag a selection across lines and Markdown blocks within a response, then press Ctrl+C to copy it. Each code block has its own **Copy code** action. **Show message source** switches to the exact selectable text; **Show formatted message** restores formatting. Partial history stays literal until its opening is loaded.

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
