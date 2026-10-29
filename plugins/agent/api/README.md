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

# maka-agent-api

[简体中文](README.zh-CN.md)

Contains Agent, Session, Executor and WorkHub wire declarations, plus the Agent configuration schema. Native services and SDK generation share these definitions. Use this crate when a consumer needs the public contract without pulling in the Agent execution engine.

Independent Desktop clients consume the same persisted Agent service through the Root-bound [public Host client](../../../platform/host-runtime/src/application/host/client.rs); they do not open Agent storage or embed its execution engine. [Agent contracts](src/contract.rs) and [interaction contracts](src/contract/interaction.rs) are the source of field definitions and schemas.

Read `history` pages under one fixed `through` fence and resume `watch` from its last `nextAfter`; watch also publishes queue and pending-interaction updates. `send` admits work and returns its identity; `stop` names that exact invocation. Use `pendingInteractions`, `interaction` and `respond` to reconstruct and answer the original request after reconnecting. Mutations retain their original operation receipts: a lost response does not authorize another send. See [native acceptance](../native/README.md) and [transport ownership and exit modes](../../../platform/transport/README.md).

History row references use `position: { sourceSequence, itemIndex }`, ordered by the original emitting event and then its row ordinal. Cursors, source reads, prompt anchors and tool-image references share this position. `through` and `{ kind: "event", sequence }` still address raw events; a model completion publishes all of its rows at that completion’s event.

`search` scans the selected Session’s history with a literal query and explicit `caseSensitive` and `wholeWord` options. Case-insensitive matching uses Unicode simple case folding without normalization; whole-word matches require no adjacent Unicode word character (letters, marks, decimal digits, connector punctuation or join controls). Start with `after: null`. Keep the query, options and `through` fence fixed while advancing `nextAfter`, including pages with no hits; null ends the scan. Each hit identifies the exact original field for `source` reads. Open a hit in `history` with `{ kind: "row", position: hit.position, field: hit.field === "thinking" ? "thinking" : "body" }` and that same fence; this includes empty tool rows and reveals an explicitly targeted internal tool without exposing subsequent hidden rows. Byte continuation cursors remain exclusive of already-read content.

Executor `execute` receives immutable files through one optional binary resource named `attachments`. Its metadata is an ordered array of `{ name, mimeType, bytes, digest }`; the resource contains the original file bytes concatenated in that order, with each offset determined by preceding lengths. Read through the actual request resource, which retains Host byte-budget and cleanup custody; metadata alone grants no access.

`fork` starts a side conversation from a complete Turn or all current history, guarded by the source revision. Included work must be settled; an earlier complete Turn can still be forked while a later Turn runs. The new Session retains that history and its attachments, shares the verified workspace, and starts with narrowed permissions and no active work. Its `branch` identifies the source. Recover a lost response with the original operation reference; `forkReceipt` can locate a published fork even when the Host outcome remains unknown. A null result does not prove that nothing happened or authorize a replacement fork. See the [fork declarations](src/contract/fork.rs).

`diagnostics` reads bounded, newest-first pages of execution, model-step and automatic-title failures under a fixed `through` fence. `watchDiagnostics` emits the current diagnostic revision on subscription and after changes; reconnect by reading the latest page again. These session-scoped operational records retain original invocation/event identities and safe typed causes. They exclude provider bodies and failures belonging to copied source sessions. Their revision is independent of conversation history, so a late title failure remains discoverable after the answer finishes.

`context` reports the latest Main request prepared by the selected Session, including requests still running or interrupted. It groups the original Host input by message role and tool schemas; token counts are estimates, while provider-reported input usage is separate. Pin `through` to reread the same result after reconnecting. Missing requests or measurements remain null, and copied history does not count as a request executed by the new Session. See the [context declarations](src/contract/context.rs).

UI plugins with a bound `agent` import read `context.services.agent[0].query('compactionPrompt', { sessionId })`: the result contains `revision`, raw nullable `prompt`, complete effective `compactionPrompt` and inherited `defaultCompactionPrompt`. Only null inherits the global setting (or language built-in); empty and whitespace-only overrides are valid. Save with `setCompactionPrompt` using that revision and handle `MetadataResult`, including `revision_conflict`. This affects new work; captured execution/queue prompts stay unchanged. `compact.prompt` remains a one-time override. With `current` holding the validated query result and `ServiceMethods` imported from `@maka-agent/plugin-sdk`, reset inheritance as follows. See the [compaction declarations](src/contract_compaction.rs).

```ts
const input = {
  sessionId,
  expectedRevision: current.revision,
  prompt: null,
} satisfies ServiceMethods['agent']['setCompactionPrompt']['input'];
const operation = await context.services.agent[0].mutation('setCompactionPrompt', input);
```

`gitStatus` and `gitDiff` read the selected Session's repository through the same Agent service, including WorkHub coordinator sessions. Status separates staged, worktree and untracked changes; a path can appear in both staged and worktree areas. Diff compares HEAD to the index, the index to the working file, or an empty file to an untracked file, respectively. An unborn repository has a null `head`; a workspace without a repository returns null. Paths use exact Git pathname bytes encoded as `bytesBase64`, and renames appear as deletion plus addition.

These are fresh, read-only observations, not repository snapshots. Status returns the complete list of staged, worktree and untracked entries. Per-file diff reads complete inputs and returns text, binary, unchanged or unsupported; text patches are returned in full. Repository metadata, control files, status entries, diff inputs and patches are buffered in memory. Cancellation is cooperative; these queries do not promise bounded memory or a fixed execution time. The workspace must be the repository root. Unsupported repository features fail explicitly, including external filters, sparse checkout and submodules; configured commands are never executed. A changed workspace or comparison base requires a fresh query. [Git declarations](src/contract/git.rs) define the wire types; `snapshotPatch` captures an immutable completed-work patch after workspace writers settle. Capture reads complete source images and buffers the complete patch before publication; `readPatch` returns recoverable pages from that original artifact, including after later executions and Host restarts.

`listFiles` lists direct children of the selected Session workspace; `watchFiles` reports when that directory needs rereading. Both also work for WorkHub coordinator sessions. Use null `path` for the workspace root, or a `WorkspacePath` carrying exact relative pathname bytes as `bytesBase64`. Symlinks are leaf entries; `.git`, the workspace marker and private Host state/control directories are excluded, including in unrestricted model workspaces. Only the Session’s validated managed worktree is readable inside private state. Pages contain at most 128 entries with a soft 512 KiB byte target; one complete first entry can always advance. Paths preserve complete relative bytes. Unsupported platform filenames fail explicitly instead of being converted lossily.

`fileCandidates` is a finite subscription over the same Session workspace. Input `{sessionId, query, directory?}` selects the workspace root when `directory` is omitted or null. An empty or whitespace-only query browses all eligible direct files and directories there; a nonempty query searches relative file paths only within that directory's descendants. Emitted items are `{entries: [{path, kind}, ...]}` batches retaining the original workspace-relative `WorkspacePath` bytes; append batches until EOF. As with `readFile`, successful final completion is null, so the method output schema admits both batch objects and that completion value; the producer never emits null as a data item. Batches target the existing `readFile` byte quantum without truncating an entry or result set. Closing the subscription cancels traversal and waits for its worker; emitter backpressure pauses the producer. Workspace-local `.rgignore`, `.ignore`, `.gitignore` and directory-type `.git/info/exclude` rules apply, without following directory or ignore-file symlinks or reading candidate contents. Search results confer no additional read authority.

`readFile` is an ordinary UI subscription for one current regular file at an exact `WorkspacePath` under the same Session authority. It captures complete UTF-8 text or original supported image bytes, with no-follow directory/file handles and checks of workspace, permission boundary and file identity before publication. It emits `begin`, Base64 `chunk` items of at most 32 KiB original bytes, then an explicit `end` item; the subscription final value is null. Text chunks end at UTF-8 boundaries. Consumers must check contiguous byte offsets, the matching version/size/digest in End, and the complete SHA-256 digest before accepting the content. Missing End means incomplete delivery. Absent, changed, binary and unsupported file kinds are explicit; permission, invalid-path and IO errors remain failures. Empty files are valid text.

The version binds original bytes, physical file/parent identity and pathname; optional `expectedVersion` is a reread precondition, never permission. All chunks of one read come from the same complete native buffer, so replacing the path during delivery cannot mix versions. No durable artifact or atomic filesystem snapshot under concurrent writes is promised. A new read reauthorizes the Session and captures current content; historical `toolImage` keeps its separate immutable source authority. Drain through successful subscription completion and cleanup before accepting a preview; close the subscription to cancel, then await its original cleanup.

Start the watch, wait for `ready`, then read the first list page and compare its `directoryIdentity` with `ready`. Follow `next` for further pages; a `changed` notification means discard the cursor and reread from the beginning. Pages are live observations, so concurrent edits can change pagination. Notifications can coalesce and are not a replayable event history: reconnect with a new watch and fresh listing. Detected deletion or replacement of a selected subdirectory ends the watch with `unavailable`; invalid Session/workspace authority or filesystem observation failures end it with an error. Close the subscription when leaving the directory.

On macOS, active watches also compare direct-child metadata. Each scan is followed by a pause of at least one second, extended to nine times the scan duration for expensive directories; this targets a 10% scanning duty cycle per subscription, rather than a fixed delivery deadline or total CPU limit. This detects persistent changes even when native notifications arrive late; unchanged scans emit nothing. Scans do not read file contents, follow symlinks or descend into child directories. `ready` waits for the initial scan; large directories or slow storage can delay readiness and later notifications. Closing a subscription waits for its active filesystem work to settle.

[Source](src/lib.rs) · [Cargo manifest](Cargo.toml)
