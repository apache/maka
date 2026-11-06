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

The [NSH design guide](third-party/nsh/website/docs/design-guides.md) is the baseline. This file records what Maka decides on top of it. [`ui.tsx`](products/maka/workbench/app/ui.tsx) owns the values; when this file and the source disagree, fix the wrong one in the same change. The terminal shares the workbench but keeps its cell grid, so desktop geometry stays behind `platform.isTerminal`.

## Hierarchy

- One region has one focus. An element earns its place by changing what the user does next.
- With accent and decoration removed, the primary task, current selection and next step must still read.
- Assistant messages stay quiet and free of avatars. Language and continuity carry the product's character.
- Messages between agents belong with tool activity, not in user bubbles. Keep their content folded by default, with source conversations and full text available on expansion. Expanded activity groups use the shared disclosure content inset for their members (32 points on desktop), matching tool details and thinking.

## Surfaces and lines

- Depth comes from the `background`, `surface` and `raised` tokens first, then a line, then a shadow.
- Each boundary uses one separator: a fill step, a line or a shadow, never two on the same edge.
- Resting surfaces are flat. Shadows belong to what floats (menus, popovers, dialogs, tooltips), and that family shares one recipe.
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
- Actions stay reachable without hovering.
- A loading state occupies the box of its ready state: the switch causes no layout shift.
- Feedback reports real state. Immediate actions get no ceremony.

## Settings

Settings pages are built from the parts in [`SettingsPage.tsx`](products/maka/workbench/app/SettingsPage.tsx); a page adds no layout of its own.

- The rail names the page; the panel's title row repeats that name at the root, adds back when nested, and holds the page's one action. Nothing else repeats the title.
- Rows put the label on the left and the control on the right. Rows sit in groups on `surface` over the panel's `background`, one inset line between rows; a group may carry a section name. The title, section names, row text and notes start on one left edge, the group's text inset; only group backgrounds reach past it. Descriptions only where the label alone would mislead.
- Choose the control by purpose: a switch for on/off, a select for one of several (side-by-side buttons when there are two or three short ones), a chevron row for a page below, a button for a command. Destructive commands are a danger row at the end of the last group; lists open an item's page rather than carry per-row commands.
- Switches and selections apply on change; typed values (names, keys, URLs, prompts) wait for Save in the page footer, which stays in view while the page scrolls and appears on a saved item only once something changed. A switch flipped while typed changes are unsaved joins them and waits for the same Save. A page whose values only make sense together (a server, a model, a proxy) is a form: there every control for those values waits for Save, while a switch that sets something outside the form, such as the default model, still applies on change.
- There is no Refresh control. A page reads its data when it opens and again when the window returns to the foreground, unless a draft or confirmation is open. A failed read shows Retry where the data would have been; the reason shows under the title.
- A row shows state only when it needs action, in `warning`. A healthy state is silent.
- Search appears once a list is too long to scan, about eight items.
- Multi-line text is sized in whole lines and fades at the bottom while more text is hidden.

## Verification

A visible change is reviewed in the real desktop renderer, in light and dark, at a narrow and a wide window. Geometry that must stay equal is asserted against resolved bounds, as `desktop_composer_keeps_one_inset` does: a screenshot judged by eye does not prove alignment. On macOS the headless test platform draws text in Helvetica rather than the system font, so judge typography and the centering of text beside icons with the real text system.
