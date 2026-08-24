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

# Composer mention popups (`@` file / `/` skill) — v1 spec

Date: 2026-07-14
Branch: `feat/composer-mentions`

## What shipped

Typing `@` or `/` in the chat composer (at a word boundary) opens a popup:

- `@` → workspace file reference. Filtered live against `workspace:searchFiles`
  (git `ls-files` in a repo, bounded readdir walk otherwise). Selecting a file
  inserts the plain-text token `@<relativePath> ` (with the `@` and a trailing
  space).
- `/` → skill reference. Filtered client-side against the enabled skills list.
  Selecting a skill replaces the `/query` token with `使用 <skillName> 技能：` —
  the exact house convention from `useSkillInChat` (app-shell.tsx). This is
  human-in-the-loop: it fills the composer, it NEVER auto-sends.

## Competitor model vs. our v1 model

**Competitors (QoderWork / WorkBuddy, from decompiled bundles):** the composer
is a `contenteditable` surface. A mention becomes an *atomic chip* — a
non-editable inline node carrying a typed wire token (`@[file:/abs/path]`,
`@[skill:id]`) that the runtime parses out of the message. Backspace deletes the
whole chip; the rendered label and the wire token are decoupled.

**Our v1:** the composer is an *uncontrolled native `<textarea>`*
(`packages/ui/src/composer.tsx`; text lives in the DOM, not React state). Rather
than migrate to `contenteditable` + a chip model, v1 inserts **plain text
tokens** directly into the textarea value:

- File → `@<relativePath> `
- Skill → `使用 <skillName> 技能：`

Our agent runtime already reads files by path via its tools, so a bare path
token is sufficient context — no `@[file:…]` wire format, no chip nodes, and no
runtime changes are needed. The popup is pure composer-local UI.

## Trigger detection (pure, unit-pinned)

`detectMentionTrigger(value, caret)` in `packages/ui/src/chat-input-behavior.ts`
(tests in `packages/ui/src/__tests__/chat-input-behavior.test.ts`):

- The char before a trigger must be start-of-input or whitespace, and this
  boundary rule defines what *counts* as a trigger: a `/` inside a path
  (`@src/app`) or an `@` inside an email (`user@host`) is NOT a trigger, just
  query text. Detection scans left from the caret for the **nearest
  boundary-anchored** `@`/`/` (this is the "consider the nearer one" rule
  applied to real triggers).
- `@` query: invalid on `\n` or a double space `"  "` (single spaces allowed —
  filenames have spaces).
- `/` query: invalid on ANY whitespace (single-token).
- Returns `{ trigger, query, start }` where **`start` is the index of the
  trigger char itself**.

Matcher `mentionQueryMatches(query, text)`: case-insensitive AND-of-substring
over whitespace-split tokens.

## Deviations from the synthesized spec

1. **Insertion splice range.** The spec text said "replace `[start-1, caret)`",
   which assumes `start` points *just past* the trigger. Our unit-pinned
   `detectMentionTrigger` returns `start` = the trigger-char index, so Composer
   replaces `[start, caret)` (trigger char inclusive). Same net behavior (the
   trigger char is replaced); the field just has a cleaner meaning.

2. **Boundary-anchored nearest trigger (not raw `lastIndexOf`).** The spec's
   literal "last `@` and last `/`, nearer wins" makes a path-internal `/` (e.g.
   `@src/app`) the nearer trigger; since it fails the boundary check the whole
   popup would close the instant you type a slash — breaking the primary use of
   `@` (file paths). Because the spec explicitly wants `@` queries to hold
   slashes and spaces, the boundary rule is applied *while choosing* the
   trigger: only boundary-anchored `@`/`/` are candidates, and the nearest such
   candidate wins. A non-boundary `@`/`/` is treated as query text. Pinned by
   the `chat-input-behavior` tests (`@src/app` → `@` with query `src/app`).

## v2 upgrade path

If/when richer references are needed (display label ≠ inserted value, atomic
delete, structured wire tokens, `@`-mentioning symbols/URLs):

1. Migrate the composer to `contenteditable` (or a controlled rich editor).
2. Insert mentions as atomic inline chip nodes carrying a typed token
   (`@[file:…]`, `@[skill:…]`).
3. Serialize chips → wire tokens on send; teach the runtime to parse them.
4. Caret-rect anchoring for the popup (v1 is bottom-anchored above the textarea;
   caret-rect measurement was explicitly out of scope).
