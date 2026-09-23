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

# Next prompt suggestions: implementation and native acceptance

Implemented on `codex/prompt-suggestions`, based on upstream/main `5263fb78a2c56037e681bfe4bebafce9e7e0b141` (2026-09-22).

## Product behavior

Enable **下一步输入建议 / Next prompt suggestions** in the composer + menu. The device-local setting defaults to off and explains the extra model request. A witnessed completed reply with an empty draft may produce one short suggestion. Tab or clicking the suggestion inserts an editable draft; Enter sends normally. Esc dismisses. Native Undo removes the insertion. Typing, IME composition, session navigation, another turn, attachments/references, or disabling invalidate the offer. Removing the typed text does not resurrect it. Opening old history does not generate suggestions.

The first version supports ordinary AI SDK sessions. Runtime Host rejects in-progress/failed/aborted turns, pending interactions, queued work, active goals, plan/side/agent sessions, archived sessions and incognito mode. It reads canonical session state itself; the client supplies only session identity. The current session model supplies a bounded, tool-free auxiliary request, metered as `prompt_suggestion`, with 128 output tokens and a five-second timeout. At most the original user message and six recent user/assistant messages are supplied, each capped at 2,000 Unicode code points. A bounded ephemeral cache deduplicates requests across clients; canonical turn changes and Host drain abort pending work. Suggestions never write transcript messages until the user sends.

The visual suggestion is a sibling overlay outside contenteditable, with no layout-measuring state feedback and no historical inlineCompletion prop. See [historical reproduction](../prompt-suggestion-repro/README.md) for the separate, inconclusive old-crash investigation.

## Actual validation

- Runtime Host and UI builds, desktop production build and renderer typecheck passed.
- Host protocol registry tests: 84 passed. Coordinator plus provider/execution composition suite: 44 passed on final run. An earlier run timed out in the existing implementation-child-patch test; that test passed alone and the entire 44-test suite passed on rerun.
- Focused coordinator, hook and retained seam tests passed; provider authority and IPC tests cover authentication, usage metering, tools absent, ID validation and no automatic retry.
- Renderer architecture, ASF header audit and whitespace checks passed.
- `smoke.mjs` launches actual Electron with an isolated temporary profile and local test credentials. The ordinary conversation uses the repository FakeBackend; suggestion generation traverses real renderer → preload → main → Runtime Host → a controlled local HTTP model endpoint. This proves wiring and interactions, not real-model prediction quality.
- [result.json](./result.json) records 10 native checks: empty ghost text, Tab without send, native undo, Esc, duplicate IPC, accepted Enter in durable transcript, three viewport/zoom sizes, typing/clear, delayed response preserving draft and disabled setting making no prediction request. No captured renderer errors.
- [01-offer.png](./01-offer.png), [02-accepted.png](./02-accepted.png), [03-after-send.png](./03-after-send.png) are actual Electron screenshots.

Run after building desktop and dependencies:

```sh
node docs/reports/prompt-suggestion-smoke/smoke.mjs
```

The harness closes its Electron instance and HTTP server on completion. It does not change the normal desktop profile. Paid-provider quality, cross-platform native behavior and exhaustive accessibility testing remain unvalidated.

## Text alignment correction

The initial overlay used different padding and inherited typography. It now matches the editable's Astryx typography tokens, 4px spacing token and 22px line height, including wrapping. Both occupy one CSS grid cell, so accepting a wrapped suggestion does not change the composer height. The Tab hint sits in the toolbar and does not subtract from text width.

Native Electron comparisons in `text-alignment.json` and `multiline/text-alignment.json` assert exact equality of glyph rectangles, font, letter spacing, whitespace and word-breaking before/after Tab. Both single-line and genuinely wrapped two-line Chinese cases passed, together with the existing interaction checks. Run the wrapped variant with `MAKA_SMOKE_MULTILINE=1 node docs/reports/prompt-suggestion-smoke/smoke.mjs`.

## WorkHub coverage gap

A separate actual Electron WorkHub check (`workhub-check.mjs`) enabled the setting, sent a message through the native WorkHub surface, waited for a completed coordination turn, and requested prediction through the bridge. Result: `kind: none`, zero model prediction requests, zero offers. See `workhub-check.json`. The initial implementation does **not** support WorkHub: its canonical source gate excludes all session roles, including WorkHub coordination. A visible shared menu does not imply working prediction. Earlier ordinary-session acceptance must not be interpreted as WorkHub acceptance.
