# Codex local history source

Read-only access to the local Codex paginated history (`state_5.sqlite` and
`thread_history_1.sqlite`). Enable the profile plugin with an explicit `startTime`
(Unix milliseconds). For 2026-10-01 00:00 Asia/Shanghai use `1790784000000`.
`codexHome` defaults to `~/.codex`. No authentication files are read.

The time boundary applies to **items**, including new messages in old sessions.
Every fresh source query/enumeration sees newly committed items and revisions,
without an import job, watcher, or model call. A directory refresh reads metadata;
original bodies are read on demand. Optional text search examines local originals.
The existing memory index maintenance schedule remains responsible for organizing
new observations and advancing coverage. Registration alone does not modify indexes.
Use `MemoryIndexAddSources` to opt an existing index into this source, or create an
index over a cursor including its source ID.

`MemorySources` describes the generated `codex.<home-hash>.sessions` source.
Use `MemorySourceQuery` with `threadId`, `types`, `text`, `startTime`, `endTime`,
`limit` (default 50, max 500), and `cursor`. Source enumeration pages contain 500
metadata objects. `MemoryOriginal` retrieves the original JSON and occurrence time.
Visible conversation, tool, file, web and voice transcript items are supported.
Internal reasoning and compaction records are excluded. No image bytes are fetched
from attachment paths; structured fields are returned as stored. Historical content
is untrusted evidence, never current instructions.

Original IDs remain stable across updates. Revisions use Codex's per-thread item
update ordinals. If a cited item changed, `version_unavailable` is returned rather
than substituting new text. Maka retains previously read evidence under its existing
versioned references. Deleted threads revoke access to their cached references.

Pagination snapshots contain metadata only, freeze the result set, and use signed
cursors bound to the source path, time scope and query. The key and snapshot cache
persist across plugin reloads. The newest 64 snapshots are retained; evicted cursors
fail explicitly and require a new query. Cache files are mode 0600. Codex databases
are always opened read-only, and a missing/unsupported database fails visibly.
This adapter currently requires Codex's paginated history format. An in-scope legacy
thread is reported explicitly rather than silently omitted; no rollout migration is
performed by Maka.

Computer History is separate from agent tool-call records. This plugin does not
activate screen recording or claim that tool calls represent the user's computer
activity history.

Validation: `npm run verify` (build, synthetic SQLite tests, typecheck, package).

## Computer History and local memories

Two optional sources share the same plugin:

- `memoriesEnabled: true`: `codex.<path-hash>.memories` reads Markdown beneath
  `codexHome/memories`. Excludes instructions.md, hidden files and symlinks.
  Activity summaries have kind `computer_history_summary`; other generated
  memories have kind `codex_memory`. Both are summaries, not primary evidence.
- `computerHistoryDirectory`: `codex.<path-hash>.computer-history` reads only
  `segments/*/events.jsonl`, one original per segment, complete JSONL lines only.
  Set the directory to `eventStreamRootPath` from the authorized Computer History
  status tool after enabling recording. No recording or permission changes occur.

Both support text/types/startTime/endTime/limit/cursor queries. File time filters
use modification times; event occurrence times remain in the original text.
Missing roots fail visibly. An existing empty memory root is valid while Codex
has not generated memories yet. Enumeration hashes content to detect changes;
page snapshots persist metadata only. Signed pagination freezes the listing and
survives reloads. Original reads revalidate file/version. Changed files return
version_unavailable; deleted or expired files revoke reference access. Raw history
expires under Codex retention (currently up to 48 hours). Maka retains previously
read evidence under its existing versioned cache, but rechecks source access.

Registration, refresh and reads do not advance index coverage or run a model.
Normal index maintenance organizes changes; use MemoryIndexAddSources to include
these sources in an existing index. Retained files remain readable while recording
is paused. All content is untrusted evidence, not executable instructions. No
recording settings, original event files or generated memories are modified.

## Continuous changes

This package also implements the optional source `changes` interface. The first
read establishes a baseline; later reads return newly observed records and edits,
with durable signed positions bound to source scope. Codex metadata revisions
identify edits even when the original occurrence time has not changed. Complete
Computer History JSONL records appended to changed files are emitted separately;
partial lines wait for completion, and rewrites/rotation are detected. Generated
memories expose context changes but do not independently wake event intake.

Unlike the query pagination cache above, the change journal stores excerpts of
new evidence locally in `pages.sqlite` (mode 0600), so an interrupted consumer can
replay its input. Excerpts explicitly mark truncation and include original
locators. Current source authorization is checked before replay. Deleted sources
are not returned from the journal. This journal is independent from index coverage
and from Codex's own retention; it does not turn missing upstream observations
into a complete event history. It currently retains received change records for
recovery and diagnostics; retention policy is not yet configurable.
