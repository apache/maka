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

# Design target: what the window must look like to be usable

Written 2026-09-25 after the first screenshot of the MVP window. Two references drive every
decision here:

- **LongbridgeAI (AllSum Nightly)**: a shipping gpui-kit chat app. Same component library,
  so its layout language is achievable one-to-one. It sets the visual bar: quiet sidebar,
  centered column, rounded composer card, empty state with a prompt.
- **Maka Desktop (Electron)**: sets the information bar: what a session row shows, what the
  composer controls are, what a turn footer says.

Screenshots are the acceptance evidence. `scripts/screenshot.sh <owner>` captures one window;
compare `maka-gpui` against `"AllSum Nightly"` and `Maka` side by side before declaring a
region done. Every rule below cites the reference that motivates it.

## Window

- Default size 1512x885 logical points (Maka's), minimum 960x600, remembered across launches
  later. Add `--window-size WxH` for reproducible screenshots.
- Native title bar hidden; traffic lights sit inside the sidebar header as in both references.
  The sidebar has a collapse button and a search button at the top right (Maka) or a search
  icon next to the app name (AllSum).
- The window title area of the main pane shows the session title ("New chat" in AllSum), not
  the State Root path. Host and connection state move to a small status indicator in the
  sidebar footer.

## Sidebar

- Width about 340 px (AllSum) to 346 px (Maka); background one step off the content
  background (`sidebar` tokens), no hard border on the right, only a subtle divider.
- Top block: app name row (AllSum "LongbridgeAI" bold) and primary actions as quiet rows with
  icons: "New task ⌘N" (Maka), later WorkHub, Extensions, Scheduled. For this phase: New
  task only, plus a disabled placeholder is NOT acceptable; ship only what works.
- Session list grouped by time: Today, Yesterday, This week, Earlier (AllSum), each group a
  collapsible header in muted text. Rows show the title only, one line, ellipsized; Maka adds
  a right-aligned relative age ("4d"). Use: title left, age right, muted.
- No status text under the title while idle. A running session shows a small spinner or dot
  before the title; a stopped or failed session shows nothing special in the list.
- No raw paths in the sidebar list. Project selection is a picker row above the list, and
  Maka's "按时间 / 按项目" segmented control under it switches grouping (By time / By
  project). The row shows the project's name and a chevron; clicking opens the folder
  picker (projects with their folder in muted text, "Choose a folder…", "Manage
  projects…"). Never show the "No projects registered" explanation; if there are none, the
  row reads "Choose a folder…" and opens the folder dialog.
- Task rows reveal a "…" button on hover (and under the keyboard cursor) that opens the
  same context menu as a right-click or Shift-F10. Flagged tasks show a small flag before
  the age. Archived tasks live in a folded "Archived" group at the end of the list.
- Footer: settings gear + "Settings" (Maka) or the user row (AllSum). For this phase: a row
  with the Host name and a colored dot for connection state, and a Settings gear that opens
  nothing yet is NOT acceptable: omit Settings until it exists.
- Selected row: filled `sidebar-accent` background, rounded, full row width with side inset.
  Hover: lighter fill. Keyboard focus: ring.

## Main pane: empty state

- Centered logo, app name, "Ask anything..." (AllSum). For Maka GPUI: the Maka icon from the
  repo assets, "Maka", one line of muted copy, then three or four suggestion cards in a single
  column, each a full-width outlined card with a sparkle icon and a prompt that a Maka session
  can actually do in a workspace (for example "Summarize this repository", "Find TODOs and
  propose a plan", "Run the tests and explain failures"). Clicking fills the composer.

## Main pane: transcript

- One centered column, max width 48rem, side padding 24 px; content starts below a 56 px
  header strip that shows the session title (AllSum "New chat").
- User message: right-aligned rounded bubble with `secondary` fill, max 70% of the column,
  16 px padding (AllSum / Maka).
- Assistant message: plain text on the content background, no bubble, markdown with headings,
  tables, block quotes, lists and emoji rendered (Maka screenshot shows all of them). Body
  size 15 px, line height 1.6.
- Tool call: compact card with the tool name, one-line summary, status marker; expanded shows
  input and result in monospace.
- Turn footer: one muted line "3天前 · glm-5.3" style: relative time + model id (Maka). Not
  "Finished" with a check icon. Failure and cancellation are shown as a muted line with the
  reason, no icon larger than the text.
- Scroll: follow the tail while at the bottom; "Jump to latest" appears only when not
  following; a minimap is out of scope.

## Composer

- A rounded card (16 px radius) with a 1 px border in `border` token and the content
  background, 24 px above the window bottom, same max width as the column (both references).
- Row 1: multi-line input with placeholder "有什么可以帮你？" / "Ask anything..." (locale), no
  visible inner border, auto-grows to 8 lines.
- Row 2 left: "+" attach button (disabled until attachments exist is acceptable ONLY if it is
  hidden, not greyed), model picker as a ghost dropdown button showing the model id
  ("GLM-5.3 ⌄"), permission mode dropdown ("默认 ⌄" / "Ask"), context usage ("4%" with a
  gauge icon) once the Host exposes it. Row 2 right: a round primary send button with an
  up-arrow icon; while a turn runs the same button becomes Stop (square icon). Never two grey
  text buttons.
- Enter sends, Shift+Enter newline, ⌘. stops.

## Typography and spacing

- Use gpui-kit size tokens; body 14 to 15 px, sidebar rows 14 px, headers 13 px muted
  uppercase is NOT used in either reference: keep sentence case.
- Vertical rhythm 8 px; group spacing 24 px; nothing touches the window edge.

## What "done" means for a region

1. Screenshot at 1512x885 next to the reference, same region, no obvious deviation in
   structure, spacing, or hierarchy.
2. Keyboard path works (Tab order, arrows in lists, Enter/Escape rules).
3. Light and dark theme both captured.
4. Tests updated; `just check` green.

## Addendum 2026-09-25 (after the AllSum menu and settings screenshots)

Reference images 3, 4 and 5 (AllSum main window, footer menu, settings dialog) add these
rules. They override anything above that conflicts.

### Sidebar header and footer

- The sidebar header row holds, left to right: traffic lights, sidebar toggle, back and
  forward (session history navigation). The main pane header shows only the title.
- Below it: app name row with a search icon at the right edge (search opens the command
  palette / task search when it exists; until then omit the icon).
- Group lists cap at N rows and end with a "Show more" link row (AllSum) that reveals the
  rest of the group.
- The footer is one row: identity left (for us the Host name with the state dot), a small
  badge right (for us the State Root's folder name). Clicking it opens a popup menu anchored
  above the row (image 4): `Settings…  ⌘,`, `Language ›` (English / 简体中文 / 繁體中文,
  current checked), `Appearance ›` (System / Light / Dark, current checked), separator,
  `Switch State Root…`. AllSum's Plan and Sign out have no equivalent here; omit them.

### Settings dialog (image 5)

- Opened by ⌘, and the footer menu. A centered modal dialog about 1056x792 at the reference
  size, dimmed backdrop, close button top right of the content pane. (Those are pixels of
  the 2000 px wide reference image; the window is 1512x885 points, so the dialog is about
  800x600 points, 53% by 68% of the window, and the left pane about 192 points.)
- Left pane (about 254 px): a search field, then a vertical nav with icon + label; selected
  row filled. Sections for us, in order: General (language, appearance), Connections (the
  LLM connection list), Permissions (default permission mode and its explanation), About
  (version, Host, protocol epoch, State Root path).
- Connections pane: title, a search field plus a segmented filter (All / Enabled / Disabled),
  then rows: provider icon (or a monogram), connection name, "Default" badge on the default
  target, provider type as description, status right (model count or "Not verified"),
  chevron. Row click opens the connection detail (models enabled, set as default, remove).
  "Add connection" is a primary button at the top right of the pane; it opens the same form
  that exists today, but inside the dialog's content pane, not as a side sheet. The composer
  menu's "Add connection…" item opens Settings at Connections.
- Escape closes the dialog and returns focus to what opened it. Nothing in the dialog
  scrolls the window behind it.

### Empty state

- The icon sits inside a circular muted disc (image 3); the app icon square is not used
  there.
