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

# Maka memory — white-box contract anchor (2026-05-29)

> Archived on 2026-07-13. This snapshot no longer owns the current memory contract.

Owner: yuejing. Anchor for the team's evolving local-memory feature
once xuan's transparent-file MVP landed at `c06e13f`. Aligned to:
- `packages/core/src/local-memory.ts` (xuan)
- `apps/desktop/src/main/local-memory-service.ts` (xuan)
- Settings → 记忆 UI (xuan)
- external reference deep-dive note `notes/external reference-deep-dive-2026-05-29.md` §3.5
- PilotDeck deep-dive note `notes/pilotdeck-deep-dive-2026-05-29.md` §2.2
- kenji `19b0996f` boundary: local transparent file MUST NOT become
  implicit durable memory; agent-read default-off.

This note is a contract anchor, not a PR. It freezes the field names
+ status semantics so V0.2 / V0.3 PRs can extend predictably without
breaking V0.1 disk format. If reality changes, edit here first.

## V0.1 — what xuan shipped (`c06e13f`)

### Settings shape (live)

```ts
interface LocalMemorySettings {
  enabled: boolean;          // file feature on/off (default ON)
  agentReadEnabled: boolean; // agent may consume in system prompt
                             // (default OFF)
}
```

Two switches were the right scope:

- `enabled` ON + `agentReadEnabled` OFF — the file lives on disk,
  user can edit, agent gets NOTHING.
- `enabled` ON + `agentReadEnabled` ON — file appears in system
  prompt as a dedicated section. Incognito context fails closed.
- `enabled` OFF — file untouched on disk; reads return disabled
  state.

### File location + permissions

- Directory mode `0700`, file mode `0600`.
- Lives under the workspace directory.
- `LOCAL_MEMORY_MAX_BYTES = 128 KB` enforced at parse time.

### Disk format (live)

Each entry is a Markdown H2 section followed by an HTML-comment
metadata line:

```markdown
# Maka Memory

## <title or slug>
<!-- maka-memory: id=<id> origin=manual createdAt=<unix-ms> -->
<content lines>

## <next title>
<!-- maka-memory: id=<id2> origin=manual createdAt=<unix-ms> -->
...
```

Parser is fail-open: an entry with a malformed comment still
renders its content. The HTML-comment metadata is intentionally
hidden from human readers in most Markdown viewers.

### Parse output (live)

```ts
interface LocalMemoryEntryPreview {
  id: string;
  origin: 'manual' | 'unknown';
  title: string;
  content: string;
  createdAt?: number;
}

interface LocalMemoryState {
  path: string;
  enabled: boolean;
  agentReadEnabled: boolean;
  status: 'ok' | 'disabled' | 'safe_mode' | 'incognito_blocked' | 'error';
  content: string;
  entryCount: number;
  latestEntry?: LocalMemoryEntryPreview;
  reason?: string;
}
```

Status enum invariants:
- `disabled` — `settings.enabled === false`. UI shows the toggle.
- `incognito_blocked` — workspace privacy context active. Even when
  enabled, no read happens.
- `safe_mode` — file is over `LOCAL_MEMORY_MAX_BYTES`. Returns
  empty entry list with a banner; user can still open + edit.
- `error` — IO error. Generalized copy in `reason`.
- `ok` — normal read.

## V0.2 — extensions on top of the V0.1 disk format

V0.2 extends the metadata comment with optional fields. **Parser
MUST stay fail-open for unknown fields** so V0.1 readers never
crash on a V0.2-written file.

```html
<!-- maka-memory: id=<id> origin=<origin> createdAt=<ms> updatedAt=<ms> status=<status> tags=<csv> decayTtlMs=<ms> -->
```

### Origin (V0.2)

```ts
type MemoryOrigin = 'manual' | 'extracted' | 'imported' | 'unknown';
```

- `manual` — user typed it. V0.1 only writes this.
- `extracted` — written by a future `extract_memory` agent tool.
  That tool MUST be `permissionRequired: true` with its own user
  approval prompt, gated on `agentReadEnabled` (you cannot
  extract what you said the agent cannot read), gated on
  `!incognitoActive`.
- `imported` — bulk-imported (Honcho / mem0 / supermemory export
  / OpenAI ChatGPT memory JSON / etc.).

### Status (V0.2)

```ts
type MemoryEntryStatus = 'active' | 'archived';
```

- `active` — surfaces in agent prompt + UI list.
- `archived` — stays in the file (user can re-activate) but does
  not enter the prompt. UI lists archived entries in a separate
  pane.

`decayTtlMs` is the auto-archive timer: when `now > createdAt +
decayTtlMs`, the next parse promotes the entry to `archived`. The
file is rewritten with `status=archived` in-line — a write the
user can see, not a hidden background mutation.

### Tags (V0.2)

`tags=foo,bar` — string CSV. Used for filtering in the UI and
optional system-prompt section grouping.

### Stable id (V0.2)

Currently V0.1 uses `manual-<unix-ms>`. V0.2 switches new entries
to `sha256(content + createdAt).slice(0, 16)` so id is stable
across edits of the title. Old `manual-*` ids remain valid; the
parser accepts both.

### Settings additions (V0.2)

```ts
interface LocalMemorySettings {
  enabled: boolean;
  agentReadEnabled: boolean;
  // V0.2:
  defaultDecayDays?: number;     // entries created without an
                                 // explicit decay inherit this
  extractToolEnabled?: boolean;  // gates the extract_memory tool
                                 // registration; default false
}
```

`extractToolEnabled` is the third switch that makes the
`extract_memory` agent tool surface. It is OFF by default and
disabled when `agentReadEnabled` is OFF (you cannot extract
memory the agent cannot use).

## V0.3 — open questions (NOT contract; revisit when relevant)

These are explicitly OPEN questions. Recording them here so the
next person who picks up the lane knows the field is not
settled.

### Provider abstraction

external reference ships `plugins/memory/{honcho,mem0,supermemory}`. PilotDeck
has `EdgeClawMemoryProvider`. reference implementation is built-in `MemoryService` +
sqlite-vec. **Three-way convergence is NOT present** — kenji's
finding `7749c411` #3. Defer abstraction until a real external
backend lands (a paying user wants Honcho or a vector store).

If we adopt:
- `MemoryProvider` interface in `@maka/core/memory`
- Built-in `LocalMarkdownProvider` (today's file)
- Plugin path for `HonchoProvider` etc.

### Vector search

Embedding generation is a separate provider lane (reference implementation's
`__local__` / OpenAI / aihubmix / openrouter / Google selector).
Independent of the memory storage backend. Defer.

### Cross-session recall

V0.1 / V0.2 always returns the whole memory file. V0.3 may
implement retrieval — emit only top-K relevant entries based on
a query. Requires a retrieval algorithm choice; vector vs FTS5
vs LLM-judge. Defer.

### Dream Mode (PilotDeck term)

Idle-window memory consolidation: when the app sits idle for X
minutes, summarize chat sessions into new memory entries. Has
serious privacy implications. Even with `extractToolEnabled` ON
this would be an additional opt-in. Defer.

### Multi-workspace memory

PilotDeck's pitch is per-workspace memory + cross-workspace
aggregation. Maka has workspaces. V0.3 could expose a
`memory.scope: 'workspace' | 'global'` field per entry. Defer.

## Contract test surface (suggested, not shipped)

When V0.2 lands, the following invariants should be enforced by
contract tests:

1. `parseLocalMemoryMarkdown` is fail-open on unknown comment
   fields — never throws, never drops a known entry.
2. `agentReadEnabled === false` ⇒ system prompt NEVER contains
   the memory section, regardless of `enabled`.
3. Workspace privacy context `incognitoActive === true` ⇒
   `LocalMemoryState.status === 'incognito_blocked'` even when
   both switches are ON.
4. `extract_memory` agent tool registration is gated on
   `extractToolEnabled === true && agentReadEnabled === true`.
5. The token-boundary contract is preserved: memory content
   crosses the renderer↔main IPC; raw tokens / API keys never
   leak into a memory entry via redactSecrets on the write path.

## Decisions log

| Date | Decision | Source |
|---|---|---|
| 2026-05-29 | Two-switch model (file enabled / agent-read enabled) | xuan `c06e13f` |
| 2026-05-29 | `agentReadEnabled` defaults OFF | kenji `19b0996f` boundary |
| 2026-05-29 | Defer provider plugin abstraction (no 3-way) | kenji `7749c411` #3 |
| 2026-05-29 | `extract_memory` agent tool: future, permission-gated | this note |
| 2026-05-29 | Dream Mode / vector / cross-session: V0.3+ open | this note |

## Pointers

- xuan implementation: `packages/core/src/local-memory.ts` +
  `apps/desktop/src/main/local-memory-service.ts`.
- Settings UI: `apps/desktop/src/renderer/settings/` (find the
  memory section).
- Test: `packages/core/src/__tests__/local-memory.test.ts`.
- external reference inspiration: `notes/external reference-deep-dive-2026-05-29.md` §3.5
  (warns against plugin abstraction without external demand).
- PilotDeck inspiration: `notes/pilotdeck-deep-dive-2026-05-29.md`
  §2.2 (white-box memory) and §3.2 (extension proposal).
