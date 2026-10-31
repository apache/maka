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

Elsewhere the same rule holds: icon buttons and disclosure rows reach 8 points past the reading column so their glyphs land on its edges, sidebar labels share one lane, and table text starts where code block text does.

## States

- Every control shows hover, press, focus and disabled through the shared styles in `ui.tsx`, and selected where it applies.
- Actions stay reachable without hovering.
- A loading state occupies the box of its ready state: the switch causes no layout shift.
- Feedback reports real state. Immediate actions get no ceremony.

## Verification

A visible change is reviewed in the real desktop renderer, in light and dark, at a narrow and a wide window. Geometry that must stay equal is asserted against resolved bounds, as `desktop_composer_keeps_one_inset` does: a screenshot judged by eye does not prove alignment. On macOS the headless test platform draws text in Helvetica rather than the system font, so judge typography and the centering of text beside icons with the real text system.
