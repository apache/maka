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

# Maka design

Maka is a desktop workspace for directing and supervising agents. The interface is calm, native and compact: generous around reading and decisions, dense where comparison matters. The task stays central; activity, permissions, failures and produced work stay inspectable without turning the window into a dashboard.

The [NSH design guide](third-party/nsh/website/docs/design-guides.md) is the baseline. This file records what Maka decides on top of it. [`ui.tsx`](products/maka/workbench/app/ui.tsx) owns the values; when this file and the source disagree, fix the wrong one in the same change. The terminal shares the workbench but keeps its cell grid, so desktop geometry stays behind `platform.idiom === 'terminal'`.

## Hierarchy

- One region has one focus. An element earns its place by changing what the user does next.
- With accent and decoration removed, the primary task, current selection and next step must still read.

## Surfaces and lines

- Depth comes from the `background`, `surface` and `raised` tokens first, then a line, then a shadow.
- Each boundary uses one separator: a fill step, a line or a shadow, never two on the same edge.
- In both appearances the sidebar sits one step below the panel, and what rests on the panel (the composer, message bubbles, tool cards, code) one step above it (`card`, then `cardRaised` for what is filled on a card). `ui.tsx` maps these regions onto the tokens; call sites inside the panel use the regions, not the tokens.
- Resting surfaces are flat. Shadows belong to what floats (menus, popovers, dialogs), and that family shares one recipe.
- Generic gradients, glowing borders, neon edges, glassmorphism, sparkle and decorative "thinking" are out.

## Ink and color

- Text uses `text`, `secondary` and `muted`. Further hierarchy comes from size, weight and space.
- One accent identifies interaction and the current selection. Status colors only mean their status.
- Call sites read colors from `C`. Raw colors belong in theme definitions and in content whose color is the data.

## Geometry

- Spacing: 2, 4, 8, 12, 16, 24, 32. Equal spacing means an equal relationship; a control's parts sit closer than controls, and controls closer than groups.
- Radius: 4 inline, 8 controls, 12 surfaces, 16 and 24 for large or conversational surfaces, full for round controls and pills.
- Nested corners are concentric: inner radius = outer radius − inset.
- Control height: 24, 28 or 32, with 32 as the default. Text uses the styles in `ui.tsx`.
- The container owns its inset and the parent owns the gap between children. Fix a drift at that owner, never with a local offset.

## Alignment

Every surface has a few shared edges and center lines, and siblings land on them. Two edges meant to be equal and one rendered pixel apart are a defect.

The composer is the reference:

- The card has radius 24 and inset 8, so its 32-point round buttons (radius 16) are concentric with it.
- The `+` glyph and the first character of the message share a left edge.
- The send button sits the same distance from the right and bottom edges, in the empty state and in a conversation.
- Toolbar controls share one center line, with labels and chevrons at one spacing.
- The card and the reading column share both edges.

Elsewhere the same rule holds: icon buttons and disclosure rows reach 8 points past the reading column so their glyphs land on its edges, sidebar icons, workspace names and conversation titles share one left edge, and table text starts where code block text does.

## States

- Every control shows hover, press, focus and disabled through the shared styles in `ui.tsx`, and selected where it applies.
- Hover only reveals. Actions that show on hover also show on keyboard focus, keep their space while hidden, and stay in a context menu with the same commands.
- A loading state occupies the box of its ready state: the switch causes no layout shift.
- Feedback reports real state. Immediate actions get no ceremony.

## Shell

The desktop window is an inverted L: the sidebar and the window's top edge share one base (`chrome`), and the content is one `panel`, radius 12, inset 8 from the window's top, right and bottom edges. The sidebar, the panel and the panel's header part by fill alone; panes side by side in the panel part by a line.

The shell keeps one header line. The window controls' row holds only the controls and the sidebar toggle at the sidebar's end (the panel's header takes the toggle while the sidebar is away). Each pane's header is the panel's first row, 32 points high, so its center is the window controls' center: the title, the workspace, then the pane's views as a compact segmented control at its end. Nothing else repeats the title.

The sidebar recedes behind the conversations: navigation rows read in `secondary` with `muted` icons, conversation titles in `text`. Selected is a `raised` fill with the title at weight 500; unread and running show in one 16-point lane at the row's end (an accent dot, the loading indicator), the More button's place, so titles never move.

## Conversation

- Assistant messages stay quiet and free of avatars. Language and continuity carry the product's character.
- Messages between agents belong with tool activity, not in user bubbles. Keep their content folded by default, with source conversations and full text available on expansion.
- A turn has one summary row from its first step to its end, and finishing changes only its text and fold. While it runs, the row reads `Working for 22s` and its steps and the messages between them follow in order below it, with no group headers. Once it completes it reads what it took and what it did (`Worked for 37s · 2 thoughts · 3 tools`) and folds to the final answer, unless the user has already opened or folded it. A turn that failed, stopped or took the user's input midway leads with its status (`Stopped after 12s`) and stays open, since it does not fold.
- A turn is not indented. On desktop it has two lanes: the icon lane on the reading column's left edge holds the summary chevron, each step's icon and an expanded tool card's left edge; the text lane, 24 points to its right (`disclosureContentInset`), holds the summary text, step names, expanded thinking and the text inside the card. Thinking and tool steps share one row style and differ only by icon; a thinking step with nothing beyond its title does not expand.
- A step's state sits in one fixed lane at the row's trailing edge and shows only error, rejection, stop or progress. A tool card names its tool and directory once, prefixes the command with `$`, and labels output only when it is stderr; an exit code shows only when non-zero.

## Floating surfaces

Menus, selects, context menus, popovers and dialogs share one edge: a `line` border, radius 12 and a shadow, the only edge where a line and a shadow meet. `ui.tsx` and `ModalDialog.tsx` own the recipes.

### Menus and popovers

Menus, selects, context menus and popovers share one surface and one row (`floatingStyle`, `menuRowStyle`).

- The surface sits one step above the panel (`floating`); inset 4 keeps its rows (radius 8) concentric. Rows inside it hover and take focus with `floatingRaised`.
- A row is 32 points high with three lanes: a 16-point icon 12 points from the surface's edge, the text at 36, and a trailing lane for the check, a switch, a shortcut or a submenu chevron. Detail follows the title in `muted`, on the same line in a list to scan (completions) or on a second 12-point line where it explains a choice (sandbox levels). A shortcut is never the detail.
- Each command has its own icon in `secondary`; no two commands in one menu share an icon. A destructive row is `danger`, icon and text, and comes last. A command that asks for more input ends with `…`.
- The current choice is a check in the trailing lane in `accent`; menus draw no radio buttons. A two-state setting is a switch row.
- No title and no close button: the trigger names the menu, and a press outside or Escape closes it. A list that mixes kinds (commands and skills) names each section, and keeps the name when only one kind matches. Section names and notes start on the icon's edge; separators are inset 8 and part groups by purpose. A search field is the first row, borderless, with a separator below.
- A list of recent items keeps the latest ten, so it has no command to remove one.

### Dialogs

Dialogs share `ModalDialog`: the scrim, a width that follows the decision (alert, form, editor or page), inset 16 and a deeper shadow than a menu's. The card keeps `surface`, the fill its controls' `raised` and `background` are set against.

- Choose the smallest surface that holds the decision (NSH, Feedback and overlays); exploring belongs in a page.
- The title names the decision and its object (`Delete “Roadmap”?`), weight 600; the detail adds only scope, consequence or recovery. Header and footer parts sit 8 apart.
- Actions sit at the bottom right: Cancel, then the result (`Delete`, `Create fork`, `Save`), never `OK` or `Confirm`. A destructive result reads in `danger` and focus starts on Cancel. A view with nothing to decide has only Close. A secondary choice sits at the bottom left.
- One way out: Escape does what Cancel or Close does; a press on the scrim does too only for a launcher, so a stray click loses no input or running work. No close button in the title row.
- A confirmation takes `AlertDialog`'s shape but is drawn by Maka: in the terminal surface the system's alert would open on a hidden window. Progress and failure stay in the dialog until it closes.
- A launcher (the command palette, conversation search) opens an eighth of the window down, so typing does not move it, and has no title; the palette's list follows the menu rules.
- A page-sized dialog (model settings) is shaped as a window, its pane 8 in and concentric with its corner.

### Tooltips

Tooltips keep NSH's bubble (`tooltipStyle`, `richTooltipStyle` for more than a line) in the floating colors: no shadow and no inverted colors. A menu row carries no tooltip; what it would say belongs in the row.

## Settings

Settings pages are built from the parts in [`SettingsPage.tsx`](products/maka/workbench/app/SettingsPage.tsx); a page adds no layout of its own.

- The rail names the page; the panel's title row repeats that name at the root, adds back when nested, and holds the page's one action. Nothing else repeats the title.
- Rows put the label on the left and the control on the right. Rows sit in groups on `surface` over the panel's `background`, one inset line between rows; a group may carry a section name. The title, section names, row text and notes start on one left edge, the group's text inset; only group backgrounds reach past it. Descriptions only where the label alone would mislead.
- Choose the control by purpose: a switch for on/off, a select for one of several (side-by-side buttons when there are two or three short ones), a chevron row for a page below, a button for a command. Destructive commands are a danger row at the end of the last group; lists open an item's page rather than carry per-row commands.
- Switches and selections apply on change; typed values (names, keys, URLs, prompts) wait for Save in the page footer, which stays in view while the page scrolls and appears on a saved item only once something changed. A switch flipped while typed changes are unsaved joins them and waits for the same Save. A page whose values only make sense together (a server, a model, a proxy) is a form: there every control for those values waits for Save, while a switch that sets something outside the form, such as the default model, still applies on change. Leaving with unsaved changes asks first.
- There is no Refresh control. A page reads its data when it opens and again when the window returns to the foreground, unless a draft or confirmation is open. A failed read shows Retry where the data would have been; the reason shows under the title.
- A row shows state only when it needs action, in `warning`. A healthy state is silent.
- Search appears once a list is too long to scan, about eight items.
- Multi-line text is sized in whole lines and fades at the bottom while more text is hidden.

## Verification

A visible change is reviewed in the real desktop renderer, in light and dark, at a narrow and a wide window. Geometry that must stay equal is asserted against resolved bounds, as the desktop tests' `shell_shares_its_lines` does: a screenshot judged by eye does not prove alignment. On macOS the headless test platform draws text in Helvetica rather than the system font, so judge typography and the centering of text beside icons with the real text system.
