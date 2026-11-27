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

# UI Design Specification

Maka is a desktop and terminal workspace for directing and supervising agents. The layout stays quiet, native, and compact: spacious where users read or make decisions, dense where side-by-side comparison matters. Activity, permissions, failures, and artifacts remain inspectable inline without turning the window into a telemetry dashboard.

The [NSH design guide](third-party/nsh/website/docs/design-guides.md) sets the foundation; this document specifies Maka's rules on top of it. [`ui.tsx`](products/maka/workbench/app/ui.tsx) is the source of truth for design tokens—when prose and code diverge, update the wrong one in the same change. Terminal mode runs the same workbench on a character grid, gating desktop-only pixel geometry behind `platform.idiom === 'terminal'`.

## Visual hierarchy

- Every region has one focal point. An element earns its space only if it informs what the user does next.
- Strip away accent colors and decoration: the primary task, active selection, and next action must still read clearly from layout and contrast alone.

## Surfaces and borders

- Establish depth with surface fills (`background`, `surface`, `raised`) first, a hairline border second, and shadow last.
- Use at most one separator per boundary—either a fill step, a border line, or a shadow, never two on the same edge.
- In both light and dark themes, the sidebar sits one step below the main panel, while cards resting on the panel (composer, user bubbles, tool cards, code blocks) sit one step above (`card`, and `cardRaised` for interactive fills inside a card). Components inside the panel consume semantic region tokens from `ui.tsx` rather than raw palette steps.
- Resting surfaces stay flat. Shadows are reserved for floating overlays (menus, popovers, modal dialogs) using one shared elevation recipe.
- Avoid decorative gradients, glowing borders, neon accents, glassmorphism, sparkles, or ornamental "thinking" animations.

## Color and typography

- Foreground hierarchy uses `text`, `secondary`, and `muted`, reinforced by size, weight, and spacing.
- A single accent color marks interactive affordances and current selection. Semantic status colors (`warning`, `danger`, `success`) appear only to communicate actual state.
- Components read colors from `C`; literal color values belong only in theme definitions or data-driven content.
- Display numbers pass `number` values to `tr()` (or use [`numberFormat.ts`](products/maka/workbench/app/numberFormat.ts) outside `tr()`) for locale grouping and decimals; pass identifiers, line numbers, exit codes, revisions, and pixel dimensions as `string` to keep them ungrouped.

## Geometry and alignment

- **Spacing scale**: `2, 4, 8, 12, 16, 24, 32`. Tighter spacing binds related parts: parts inside a control sit closer than sibling controls, and sibling controls closer than distinct groups.
- **Corner radii**: `4` inline, `8` controls, `12` panels and popovers, `16`/`24` large cards and composer surfaces, `full` for circular buttons and pills. Nested corners stay concentric (`inner_radius = outer_radius - inset`).
- **Control heights**: `24`, `28`, or `32` (default `32`). Containers own their padding; parents own the gap between children—never patch alignment drift with ad-hoc local margins.
- **Shared axes**: Sibling elements snap to shared edges and centerlines; a 1 px misalignment between intended shared edges is a bug. In the composer (`radius 24`, `inset 8`, `32 pt` round buttons), the `+` icon aligns with the first character of the input, the send button sits equidistant from the right and bottom edges, toolbar items share one centerline, and the composer card aligns flush with both edges of the reading column. Icon buttons and disclosure rows extend `8 pt` outside the reading column so their glyphs land directly on the text edge.

## Interactive states

- Every interactive control implements hover, active/press, keyboard focus, disabled, and (where applicable) selected states via `ui.tsx`.
- Hover-revealed actions must also appear on keyboard focus, reserve their layout slot while hidden, and remain reachable from the context menu.
- Loading states match the exact bounding box of their ready state so transitions cause zero layout shift.

## Window shell

The desktop shell forms an inverted L: the sidebar and top strip share the `chrome` base fill, framing a rounded `panel` (`radius 12`, `inset 8` on top, right, and bottom). The sidebar and main panel separate by fill step alone; side-by-side split panes inside the panel separate with a `1 px` `line`.

Window chrome occupies a single `32 pt` top row: window controls and the sidebar toggle sit above the sidebar (moving into the panel header when the sidebar collapses), while each pane header aligns on the same vertical center—showing title, workspace badge, and a trailing segmented view switcher without repeating the title elsewhere.

Sidebar navigation keeps core actions (`New conversation`, `Search conversations`) alongside user-pinned optional features (`Maka Bot`, `Automations`, `Rooms`) managed from a `More features` popover, and omits redundant filter entries such as `Waiting for you`. Navigation rows use `secondary` text and `muted` icons so conversation titles (`text`) stand out; selected rows use `raised` fill and `500` weight. A `Conversations` section header pairs the `13 pt` caption scale used by group headings and full-width `Show N more` rows with a compact two-option segmented control (`Project` | `Time`) to switch between project grouping and chronological order. A fixed `16 pt` trailing slot holds the unread dot, active spinner, or hover `More` button so titles never shift horizontally.

## Conversation stream

- Assistant prose renders directly on the reading column without avatars.
- Inter-agent messages render inside tool activity rows rather than user speech bubbles, collapsed by default with expandable source links and payloads.
- Each turn renders a single summary header from start to finish: `Working for 22s` while running, updating in place to `Worked for 37s · 2 thoughts · 3 tools` and auto-collapsing to the final answer on clean completion (unless the user manually toggled it). Turns that fail, stop, or pause for user input lead with their terminal status (`Stopped after 12s`) and stay expanded.
- Consecutive internal steps between assistant messages fold into an activity group (`Read files, ran commands`). On desktop, turns use two unindented lanes: a `24 pt` leading icon lane aligned with the reading column's left edge, and a content lane to its right. Expanded steps sit one lane inward behind a vertical guide line under the group icon.
- Step status occupies a fixed trailing slot and surfaces only errors, rejections, stops, or active spinners. Shell tool cards show the working directory once, prefix commands with `$`, label output only for `stderr`, and display exit codes only when non-zero.

## Floating overlays

Menus, selects, context menus, popovers, and modal dialogs are the only surfaces that combine a `line` border (`radius 12`) with drop shadow (`floatingStyle`, `menuRowStyle`, `ModalDialog.tsx`).

- **Menus and popovers** — `floating` surface with `4 pt` inset and `32 pt` concentric rows (`radius 8`, hover/focus `floatingRaised`). Rows use three lanes: `16 pt` icon at `12 pt`, label at `36 pt`, and trailing check/switch/shortcut/chevron. Every command in a menu uses a distinct icon; destructive actions sit last in `danger`; commands that open a prompt end with `…`. Active choices show an `accent` checkmark (never radio buttons). Press outside or `Escape` dismisses; menus carry neither title bars nor close buttons.
- **Dialogs** — `ModalDialog` centers over a scrim on `surface` fill (`inset 16`). Titles state the concrete action and target (`Delete “Roadmap”?`, weight `600`); body text adds only scope or consequence. Primary actions sit bottom-right (`Cancel` followed by a specific verb like `Delete` or `Save`—never generic `OK`/`Confirm`), with initial focus on `Cancel` for destructive prompts. `Escape` cancels; clicking the scrim dismisses lightweight launchers (command palette, search) but never discards form edits or active work.
- **Tooltips** — `tooltipStyle` / `richTooltipStyle` in floating tokens without shadow or color inversion, the narrowest floating surface at `280 pt` and four lines of text at most: a hint folds, and what a longer one cannot say belongs inline. A hovered image is the one preview that sets its own width, up to `480 pt`. Menu rows never carry tooltips.

## Settings pages

All settings screens compose primitives from [`SettingsPage.tsx`](products/maka/workbench/app/SettingsPage.tsx) without custom per-page layouts:

- Settings occupies the window's inverted-L shell as a peer workspace surface alongside Conversations and Rooms (keeping them mounted so drafts and streaming turns survive). The left rail leads with `Back to app` followed by category destinations (folding above the panel on narrow viewports); the panel header shows the category title (with Back navigation when nested) and at most one primary page action, without a modal close button. `Escape` steps back through nested subpages and unsaved-draft prompts before returning to the app.
- Grouped rows sit on `card` over `panel` with aligned left text edges: label on the left, control on the right, and helper copy only when the label alone would be ambiguous.
- Switches and discrete pickers apply immediately; text inputs (names, keys, URLs, prompts) and coupled multi-field forms (server/model/proxy configs) commit via a sticky footer `Save` bar that appears once dirty. Navigating away with unsaved edits prompts for confirmation.
- Pages load on mount and window focus without manual Refresh buttons; failed loads surface an inline `Retry` action and error reason. Healthy rows stay quiet; actionable issues highlight in `warning`.

### Remote Access motion

- Press, hover, focus and category selection reuse the shared Settings controls and rail.
- The footer, revoke confirmation and loading state use the shared Settings body and loading indicator.
- Relay rows and QR appear in place without moving focus; the QR stays still while visible so the camera can lock on.
- Connection status, SAS and expiry update without animation; SAS appears above the QR, which remains scannable until the invitation is consumed or expires. No gestures or additional motion in reduced motion mode.

## Visual verification

Inspect UI changes in the native desktop renderer across both light and dark themes at narrow and wide viewport widths. Shared-edge invariants belong in automated layout-bound assertions (such as `shell_shares_its_lines` in the desktop integration suite) rather than eyeball checks alone. On macOS, the offscreen test backend rasterizes Helvetica rather than SF Pro, so check optical text-to-icon centering in a real desktop window.

## iPhone motion inventory

| Change | Motion |
| --- | --- |
| Settings hierarchy, menus, confirmations and new-chat sheet | Native navigation, menu and sheet transitions; system owns back gestures and dismissal |
| Computer, room and inbox selection | Native segmented selection or shared pill color transition (150 ms); replace target-bound data without animating stale rows |
| Drafts, progress and load failures | Keep form position, show progress/errors inline; no animation on streamed status updates |
| Conversation and Bot work | Desktop five-stroke mark (4 s) and native text shimmer; static mark and solid text under Reduce Motion |
| Approval actions | Approval press at 0.96 scale with a short opacity transition; no scale under Reduce Motion |

Approvals stay in a fixed one-row layout, with short press feedback and the outcome replacing the card’s action row. Pending uses the system segmented control (pill fallback off iOS); settings disclosures use the existing grouped rows and native confirmation dialogs.

Computer settings use native pushes for editors, menus for workspace scope, and native alerts for destructive changes and project MCP consent. Lists refresh in place on return; saving and download status stay inline. System transitions honor Reduce Motion; no custom animation is needed for form or catalog updates.
