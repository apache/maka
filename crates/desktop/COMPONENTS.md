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

# Desktop Components

Phase 1 of the GPUI client: connect, list sessions, read history, send, stream the reply as Markdown, answer approvals.

## Direction

- The reference is Waku's desktop client: its look, density and behavior, and its choice to draw the transcript itself. Waku is GPL: we study how it behaves and implement it ourselves; no code is copied or translated.
- Everything visible is ours: transcript, Markdown, sidebar, composer card, permission card, scrollbar, motion. gpui-kit supplies GPUI itself, `Root`, and the composer's `Textarea` (IME, undo and key handling are tested there and are costly to redo).
- We first tried to build on gpui-kit's `MessageScroller` and `TextView`. Each gap was fixable (redraw rate of the fade, marker mending, pinning the prompt, pausing the follow), but every fix fought the component's ownership of the list and the parse. Owning both is less code than patching them, and it is what lets the pieces below share one clock, one selection and one list.
- Colors are Maka's own (`DESIGN.md`): graphite neutrals, two text tiers, the Maka blue as the single accent.

## Modules

| Module | Owns |
|---|---|
| `theme` | Light and dark palettes from Maka's oklch values; synced into gpui-kit's theme for `Textarea` |
| `ui` | `pressable`, buttons, icon buttons, tooltip, copy check mark, extra icons |
| `ui::motion` | One ~30 Hz clock shared by every animation, leased per view, parked when idle |
| `ui::select` | Transcript selection across rows and blocks; copy yields rendered text |
| `ui::scrollbar` | Overlay scrollbar for a `list()` |
| `md` | Streaming Markdown: parse to flat blocks, mend the tail, fade new text, render |
| `chat` | Transcript rows and folding, tool summaries, composer, permission card |
| `sidebar` | Sessions grouped by day |
| `workspace` | Connection, stream batching, window layout |

## Checklist

Problems Waku hit and solved, restated as checks on our code.

### Transcript

- While a turn runs, the sent prompt stays pinned at the top and the reply grows below it. End space below the last row fills the rest of the viewport; before the first measurement a full viewport is reserved so the prompt does not flash at the bottom. Once the reply fills the viewport, the list follows the tail.
- A user scroll stops pinning and following; scrolling back onto the tail resumes following; dragging the scrollbar stops it for the whole drag.
- A row that has not been measured has unknown height, not zero; the jump-to-latest button waits until it is known.
- Rows have stable keys. A structural change splices only the changed range; streaming remeasures only the last rows.
- A settled turn folds its work into one "工作了 N" line above the answer; a failed turn says so; the working line appears as soon as the prompt lands.
- The hover footer is its own row, keeps its height when hidden, and copies the visible answer only.

### Markdown

- Unclosed `**`, `` ` ``, `~~` and half-typed links are closed or trimmed in a display copy of the last paragraph only; code is never mended. Tested on every prefix, and mending twice changes nothing.
- Each update reparses from the last settled block, keeping the last two open; a link reference definition forces full parses. A streamed parse ends equal to a full parse.
- The fade changes paint only, so wrapping, selection and row height stay put. It follows source arrival: after a rewrite only text past the common prefix fades; history opens fully opaque.
- Selection survives rows scrolling out of view; copy separates blocks with a blank line.

### Composer and cards

- Enter sends; Shift-, Ctrl- and Alt-Enter insert a newline. The send button becomes stop while a turn runs.
- The permission card sits above the composer, takes focus when it appears, and is keyboard reachable.

### Accessibility

Every component is done only when the macOS accessibility tree shows it with a role, a name and its state; it is also how components are checked without screenshots. GPUI reports an element only when it has both an id and a role.

- Done: the sidebar and main area are landmarks; `pressable` takes a name, so every button has one; session rows carry selection and a description; folds report expanded or collapsed; the permission card is a labeled group; the composer is a text input (gpui-kit's `Textarea`).
- `StyledText` is never reported, so each markdown block has its own node carrying its text (paragraph, heading level, list item and task state, code, table), and each message is a group naming who wrote it.
- GPUI drops a cached view's nodes when it reuses the view's last frame, so views are drawn uncached while assistive technology is listening (`workspace::embed`). To report upstream.
- To do: the header title, the composer's status and errors, and the empty and connection states are plain text; list items lack their position; table cells are one label, not cells. Focus is not reported while the window is inactive, so focus checks need the window in front.

### Frame budget

- Stream updates batch for 120 ms: one parse, one notify, one remeasure per batch.
- No animation redraws at display rate; the clock stops when nothing leases it and under reduce motion.
- The sidebar and chat are cached views, so a streaming reply redraws the chat alone.

## Later

Syntax highlighting, diffs, terminal output, queued messages, model chip, attachments, settings.
