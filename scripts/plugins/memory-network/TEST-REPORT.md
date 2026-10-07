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

# Memory Network validation — continue partial checkpoints (2026-09-30)

A fresh `complete=false` checkpoint from the index's own worker now triggers another turn after that turn finishes normally. Continuations reuse the same Session, saved content and fixed source range, with no fixed iteration cap. Instructions require working toward the entire organizing criterion and setting `complete=true` only when confident the captured range is finished. This remains plugin-owned ordinary Agent continuation, without native Goal or a prescribed content layout.

Controlled validation: **30 plugin tests passed**, with plugin build/package/typecheck and `git diff --check` passing. New regression cases cover seven partial checkpoints followed by completion on turn eight; same Session/range and retained progress; concurrent maintenance deduplication; newly arriving sources remaining incremental; stale or another Session's checkpoints not triggering continuation; a completed checkpoint superseding an earlier partial checkpoint; manual stopping; and timeout handling. Each turn retains its own timeout (10 minutes by default), rather than sharing one deadline across all continuations. Explicitly stopped workers are not restarted by the periodic scheduler; explicit maintenance can resume them.

**No new real-model 100-Session run was performed for this change.** The Sol results below predate automatic partial-checkpoint continuation and remain historical evidence, not validation of full-corpus completion with this change.

---

# Memory Network validation — restore ordinary Agent / GPT-6.1 Sol (2026-09-30)

The memory worker is restored to `cursor-v1`: one ordinary persistent background Agent turn, autonomous querying and organization, and an Agent completion checkpoint. Native Goal arming/polling and its generic plugin-agent facade additions have been removed. Source query, opaque multi-source cursors, original links, visibility checks and incremental scheduling remain.

Controlled validation: **23 plugin tests**, plugin build/package/typecheck, runtime and runtime-host builds, **4 plugin Agent service tests**, and **60 model adapter / Responses wire / deferred-tool tests** passed.

An initial real `gpt-6.1-sol` run could not read the corpus: OpenAI Responses automatically made optional filters required when `strict` was omitted. The worker manufactured blank record/message IDs and returned zero history items. A two-request upstream probe confirmed the schema transformation. The adapter now sends `strict: false` for ordinary function tools, retaining Maka's original dispatch validation. A wire regression test covers optional history filters. This is a model-interface compatibility fix, separate from indexing behavior. See [OpenAI function-calling strict mode](https://developers.openai.com/api/docs/guides/function-calling#strict-mode).

The failed attempt was stopped and preserved. The retry used Maka's native runtime with exact model ID `gpt-6.1-sol` in both foreground and worker, the first run's organizing criterion, and the same immutable versions of **100 imported Codex Sessions / 7,436 originals**. The prior index-creation request itself was excluded from the fixed snapshot. No native Goal was enabled and no previous index documents were supplied.

**Real-run result: partial organization, not successful full-range completion.**

- The default 10-minute worker timeout interrupted the first valid attempt after 34 history queries and one saved navigation document. This was a framework timeout, not a model completion decision.
- The test-only composition was then given a 30-minute timeout and a one-day retry interval to prevent overlapping automatic retries. One explicit `MemoryIndexMaintain` continued the same worker and fixed range. Repository defaults remain unchanged.
- That continuation ended normally after approximately **16 minutes**, well before its timeout. The model voluntarily saved `complete=false` and stopped. The returned controller error was `Background Agent stopped without completing the captured range; progress is retained`. There was no provider error, context overflow or Goal evaluation loop.
- **4 documents / 14 event sections**, 26,860 characters; **105 entry-original links / 103 distinct original messages**, directly citing **14 of the 100 source Sessions**. One navigation document contains no citations; the three body documents contain multiple events. Document count is not event count.
- History tools returned **259 distinct original messages**. The model browsed the 100-record directory but explicitly acknowledged unprocessed collaboration records, long-session middles and later outcomes. Tool return counts do not mean every returned byte was consumed; its saved notes also identify unread overflow pages.
- **Coverage cursor remains null; captured range remains incomplete.** The model saved detailed continuation notes rather than falsely committing complete coverage. Foreground inspection independently reported partial results after the maintenance call.
- The index distinguishes UX testing from the disk cleanup that interrupted it, separates two different disk-cleanup targets, records failed outcomes, and qualifies historical success claims. These are useful qualitative improvements, but known gaps remain: Matter implementation/test outcomes are still marked unverified, and the previously identified remote-access restoration and AgentLang Context Modules milestone remain absent from the saved body documents.
- All 103 cited originals belong to the fixed input snapshot; SQLite integrity and foreign-key checks passed. These structural checks do not establish semantic completeness.

For comparison, the first Flash result contained 9 documents, 88 links, 85 distinct originals and direct citations to 37/100 Sessions. Sol produced more detailed partial text and more references but **narrower direct source coverage**. Neither direct-link absence nor document count is an event omission rate. No exhaustive semantic ground truth was created.

The isolated test desktop is stopped after preserving the results, so this unfinished test does not continue spending model calls. Local evidence: `/tmp/maka-memory-sol-20260930/final-audit.json`, `final-network.sqlite`, `documents/`, `schema-probe.json`, and per-attempt archives. No credentials or imported raw histories are committed.

The historical results below describe earlier versions, not the current restored architecture.

---

# Native Goal integration — 2026-09-29

Current controlled validation: **25 plugin tests**, **72 runtime Agent/Goal tests**, and **16 Host Goal protocol/coordinator tests** passed. Runtime and runtime-host builds and plugin typecheck passed. The plugin reuses native Goal evaluation and continuation, with no separate evaluator.

New regression coverage: a model checkpoint and an idle worker cannot advance coverage while Goal remains active; only achieved commits the range; budget-limited/stalled outcomes retain partial content without coverage. Generic Agent Goal handles preserve their original caller authority. The native 500-character / 1,500-byte Goal condition constraint is checked in the fixture; full index requirements remain in index storage and the worker task message.

## Real 100-session result: incomplete, context overflow

Ran the exported plugin in a real isolated Maka desktop with `deepseek-v4-flash`, reusing the same 100 imported Codex histories after deleting previous index/task state. Index `91674693-1cc0-48b3-be78-6d3b2038566e`, worker `9fd3dd01-ce70-44bc-9095-b784075c95cd`, native Goal `ac2f2f5f-7d19-46fd-bea4-8add5853ae53`. The frozen source snapshot contains **101 records / 7,444 messages**: the 100 imports plus the foreground creation request, explicitly excluded from event content. One foreground Session invokes/waits on MemoryIndexCreate; one child Session performs the organization. There are not two competing index workers.

The Goal started at **20:38:49 Asia/Shanghai**. The test Host exited during the first turn at its last observed progress around 20:43. Database running flags were stale while the Host was absent. Restart retained the index and Goal, but the first turn did not automatically resume (`turn.resume.query` returned `resume_feature_disabled`). One explicit continuation message was submitted to the **same worker/Goal at 21:02:39**. Subsequent continuations came from native Goal, with no plugin-owned evaluator, scripted batch assignment, or manual reading instructions. This is not an uninterrupted run or evidence of automatic first-turn crash recovery.

At **21:48:44**, after **18 native continuation iterations**, the model request failed with `context_overflow`: **1,069,329 requested tokens versus a 1,048,576-token provider limit**. Runtime compaction was enabled and attempted recovery, but returned `no_safe_completed_span`; native Goal then became `paused`. The exact safe-boundary failure remains to be investigated, including whether the earlier interrupted turn contributed. Do not generalize this interrupted test to all uninterrupted Goal runs.

Results at that terminal state:

- **22 documents**: 18 event-oriented documents plus overview, timeline, requirements audit, and a per-record coverage ledger. Several event documents contain multiple related events; document count is not event count. The model chose this structure itself.
- **721 citation links / 647 distinct original references**, spanning 98 source records; the previous run had 9 documents and 88 links / 85 distinct references. No foreign-key violations or leftover temporary probe documents.
- Tools queried all 101 record IDs and returned **1,996 distinct source messages**. Querying a record or citing a source is not proof of semantic completeness; this remains partial organization.
- Native Goal repeatedly rejected partial self-reports and continued, uncovering previously missed AgentLang implementation, task-window plugin, review, voice, and IM-related evidence.
- **22 progress commits, zero completed coverage commits**. Multiple `complete: true` model reports could not bypass Goal. The work range remains incomplete and its coverage cursor remains null; partial documents are retained.
- Repeated deferred-tool errors add overhead: the model often calls a tool before activation takes effect, then retries after tool_search. This is separate from duplicate workers or an index scheduler loop.

**Controlled tests passed; the real 100-session run did not finish.** Native Goal integration prevents the observed premature cursor advancement, but this result does not establish reliable or efficient completion of large corpora. The worker is left paused; the plugin does not silently rearm it. Local evidence: `/tmp/maka-memory-goal-20260929/verification.json`, `failure.json`, and the preserved partial index database. No credentials or raw imported histories are committed.

---

Earlier results below describe earlier versions and are not evidence for the native Goal integration.

# Memory Network validation — cursor-based Agent organization (2026-09-29)

## Current implementation

`npm run verify`: **23 tests passed**, bundle build/export and plugin typecheck passed. This suite includes 12 new/current cursor-platform/store tests and 11 legacy storage compatibility tests. The retired batch API is not exposed to Agents.

Covered: all message types/fields included by default; explicit types/conversation projection and pagination; exact immutable source cursors; independent index boundaries; colliding record IDs across sources; late and edited messages; originals retained after edits/removal; reads and arbitrary text writes do not advance coverage; stale content/range rejection; unfinished progress retained; source visibility revocation; migration preserves legacy entries without trusting old coverage; old worker identities stay excluded; time and volume scheduling; foreground access during a blocked background worker; arrivals during indexing stay incremental.

Maka runtime build and runtime-host typecheck passed. Seven focused runtime tests passed (history query, Agent service, resource services). `git diff --check` passed.

## Current real-model run

Report: `.artifacts/live/report-1790680259240.json` (local ignored artifact).

- `deepseek-v4-flash`, through the real Maka AiSdkBackend.
- **49.423 seconds, 21 model requests, two maintenance turns, 28 tool calls.**
- Initial controlled source history: need to contact the equipment vendor; delivery due next week. Agent chose two free-form event documents plus an overview, with timelines and original links.
- Added one source message: vendor contacted yesterday; do not contact again; delivery still due next week. The same worker Session queried the delta, revisited evidence, updated documents and checkpointed the new exact range.
- Both checkpoints completed. Original citations remained in final documents. Foreground index reads did not fetch source bodies.
- Two tool errors occurred and were recovered by the model: a fabricated `memory-original:none` citation was rejected; a stale expected revision was rejected. No forced batch/retry loop drove recovery.

This uses controlled Host Agent lifecycle bindings and synthetic source histories with a real model. It is **not** a new desktop end-to-end run or a successful rebuild of the imported 100-session corpus. The previously paused desktop plugin/29 partial event entries were not resumed or replaced. Time and volume scheduling are controlled-test coverage, not live-model timing tests.

Semantic limits: source fixture messages lack timestamps. The model left “yesterday”/“next week” relative but labeled snapshot capture timestamps as recording times in places. Snapshot capture is not the original message creation time. A completed cursor represents the Agent's organization judgment, not verified semantic correctness or proof every message was read.

## Reproduce current real-model scenario

```sh
npm run verify
node scripts/prepare-test-metadata.mjs
node scripts/live-api.mjs
# Set MAKA_SCENARIO_API_KEY securely; optionally MAKA_SCENARIO_MODEL.
node --import tsx scripts/live.ts
```

No credentials or imported personal histories are committed.

---

The following results are historical and describe superseded implementations, not the current cursor-based protocol.

# Memory Network validation — 2026-09-29 lifecycle correction

## Controlled tests

`npm run verify`: **16 tests passed**, including source-directory and exported-extension installation into the actual HostPluginPlatform, Context, PluginToolService and PluginSessionQueryService. Source histories and Agent lifecycle execution are controlled adapters.

Validated: creation returns organized entries and coverage; no publication gate; index reads do not fetch source bodies; only changed source snapshots are ingested; foreground uncovered reads never mark coverage; independent indexes; multiple source IDs with colliding native record IDs; late arrivals and revised originals; filtered queries; reverse links; time and volume triggers; separate worker Session identity; foreground reads finish while a worker is deliberately blocked; atomic commits, idempotence, stale batches, visibility changes, restart of unfinished batches, exact Unicode fragments and legacy scalar-coverage migration; no-progress worker retries; post-boundary arrivals remaining pending during concurrent foreground reads.

Maka regression run: **70 tests passed** (PluginAgentService, plugin P1 and tool services, SqliteRuntimeStore). Includes a new durable history-revision test: an old-timestamp append advances the revision; identical replay does not. Core/storage/runtime builds and runtime-host typecheck passed.

## Real model scenario

Passing report: `.artifacts/live/report-1790675307491.json`.

- Model: `deepseek-flash`, actual calls through Maka AiSdkBackend.
- **47.861 seconds, 28 requests, 4 maintenance turns, 31 tool calls, zero tool errors.**
- Two separate model-backed worker Sessions created `todo` and `timeline` indexes from controlled history.
- A new original said the supplier had already been contacted; the Todo worker removed that candidate while keeping delivery follow-up. The timeline worker incorporated the later evidence.
- Both indexes ended with zero unprocessed observed fragments. One remaining Todo entry and one grouped timeline entry retained original citations.
- The test also checked that foreground index reads caused no source-body reads and that updating Todo did not acknowledge the timeline's delta.

This is a real-model plugin scenario with **controlled Host Agent lifecycle bindings and synthetic sources**, not a running desktop end-to-end deployment or a quality benchmark over the imported 4,924 personal conversations. The scenario above used controlled lifecycle bindings; the separate desktop run below exercises the production Host creation binding. Timed and volume triggers are covered by controlled tests, not by waiting 30 minutes in the live-model run. No real Feishu connector is included or tested.

## Reproduce

```sh
npm run verify
node scripts/prepare-test-metadata.mjs
node scripts/live-api.mjs
# Supply MAKA_SCENARIO_API_KEY in the environment; optionally MAKA_SCENARIO_MODEL.
node --import tsx scripts/live.ts
```

No credentials or personal imported history are included in tracked files. Raw reports are local ignored artifacts. Earlier reports test the superseded foreground-maintenance implementation and are not evidence for this lifecycle.


## Real desktop end-to-end — 2026-09-29

Built runtime-host and desktop, launched an isolated Maka desktop profile, installed the exported extension using `plugin.package.install`, and submitted the request through the actual chat UI. Used the configured `deepseek-v4-flash` connection. Imported three real historical conversations through `external-session.import`; no test fixture supplied worker responses or index entries.

The foreground Agent chose its own event-organizing criterion and called `MemoryIndexCreate`. The production Host created a separate persistent `Memory: 事件记忆` worker Session. The first run uncovered a real integration bug: optional `undefined` fields in tool results failed the canonical RuntimeEvent ledger with `RuntimeEvent is not losslessly serializable`. Fixed the plugin's tool-result boundary to return canonical JSON and added a JSON round-trip shape assertion to the Host test fixture. Rebuilt/reinstalled the extension and reran `npm run verify`: **16 tests passed**.

After the fix, the foreground Agent reused its index and called `MemoryIndexMaintain`; the real background worker completed in about 91 seconds. The foreground then read entries and originals, checked reverse links, and returned its final answer in the desktop UI. Result: **8 event entries, 47/47 observed fragments processed, zero pending fragments, 44 original links, no dangling links, no uncited entries, and a clean SQLite foreign-key check**. Examples included a PR review followed by approval and a disk-cleanup request followed by its reported outcome. Entries retain background, decisions, subsequent changes, timelines and citations; interrupted work is distinguished from completed work, and conceptual answers from executed actions. Timelines in stored entries use raw millisecond timestamps with approximate date labels; the foreground answer converted the two sampled timelines to readable UTC times.

Limits: the successful run resumed an initially failed creation after a plugin fix; it is not evidence of an uninterrupted first-attempt creation. Coverage means originals were processed, not that model interpretation is guaranteed correct. This test covers three real histories, not the entire imported corpus. An initial attempt to launch a complete copy of the older workspace failed during Host recovery with `Invalid RuntimeEvent schema`; that separate historical-data compatibility issue remains unresolved. The original workspace was left untouched; the successful test uses a fresh isolated profile with officially imported histories. Time/volume-triggered maintenance remains covered by the controlled tests above, not this manually initiated desktop run.


## Real desktop scale test — latest 100 Codex conversations

Replaced the preceding three-conversation test index (backed up before removal; originals retained), selected the latest 100 Codex catalog records by update time including archived conversations, and imported all 100 successfully using the current Host's official import operation. The foreground Agent read the exact scope manifest and itself called `MemoryIndexCreate` with all 100 IDs. Independent verification confirmed exact scope equality. The selected histories yielded **7,914 original fragments** (the database also retains 47 out-of-scope originals from the previous test).

This is an **in-progress scale test, not a full-corpus pass**. Real model execution exposed and motivated three plugin fixes:

- Count-only batches (default 10, maximum 20) produced excessive round trips. Batches now support a selectable count and text budget, preserving whole fragments and exact coverage; defaults are 200 items / 64,000 characters, with maxima 1,000 / 128,000.
- Mistyped original UUIDs were rejected atomically, but the generic error made the model repeatedly fetch a new batch. Rejections now identify all invalid submitted refs and explicitly say nothing was committed and all intended changes must be resubmitted after correction. The live model subsequently used the more specific error.
- `MemoryIndexRead` returned a page of full event bodies, making a simple progress query unnecessarily large. It now returns at most three bounded previews, an explicit visible entry count and scope record count; complete entries remain available separately through `MemoryIndexEntries`. The new count respects source visibility.

The updated verification suite passes **19 tests**, including byte/character-bounded batch continuation, no partial writes on invalid citations, exact error diagnostics, and bounded overview/full-body retrieval. Build, extension packaging and typecheck pass. Each extension update was installed through the actual Host package lifecycle; this run includes deliberate hot upgrades and is not an uninterrupted first-attempt benchmark.

A foreground query during live background organization successfully read coverage and checked three event/original reverse links without invoking maintenance. The initial query was slow because of full-body overview output; a follow-up tests the compact overview after the fix. At 18:35:12 Asia/Shanghai the worker recorded its real 10-minute timeout with **692 processed fragments**. Without another user maintenance command, the timer restarted it at about 18:35:20, and by 18:35:58 coverage had advanced to **732** with committed entries intact. No successful full-corpus maintenance completion is claimed. Latest local progress and source/import manifests live under `/tmp/maka-memory-100-20260929/`; raw personal histories are not checked in.


## Bare LLM extractor — 2026-09-30

Added `MemoryExtract` through the existing `ctx.llm.generate` plugin interface. No new runtime API or child Agent is involved. Seven controlled regression cases cover source/package-bundle activation, 600-message / >200k-character single-call input and lossless output files, immutable delta and filtering, pagination receipts, oversize rejection before model use, output truncation/unknown-reference flags, visibility revocation, timeout and caller cancellation. The suite now has 37 passing tests. Build, extension packing and typecheck pass.

The controlled LLM is a fixture; these tests do not establish real-model extraction quality, speed or pricing. The opt-in live harness now wires extractor calls to real `generateText` with the same DeepSeek model and request budget as its executing Agent, rather than allowing a fixture extraction. Those controlled tests alone do not constitute a live extraction run; the subsequent desktop continuation is recorded below. The tool currently inherits its caller's model in the production Host. Character input limits must not be advertised as model-token budgets.


## Sol + extractor desktop continuation — 2026-09-30

Stopped the prior Graph/Swarm run and retained the existing fixed 100-Session cursor, index documents and citations. Installed the exported extension into the isolated desktop Host and started a normal `gpt-6.1-sol` Session, without Graph/Swarm or child Agents. The extractor inherits this same model; this is **not** a DeepSeek extractor benchmark.

Initial real requests exposed two Codex OAuth compatibility failures in the generic auxiliary model path: non-streaming generation was rejected, and the streaming retry rejected `max_output_tokens`. The Host now uses streaming for Codex OAuth and leaves its output limit to that endpoint, while preserving requested budgets for other providers. Three controlled transport regressions pass (stream text/usage, provider failure propagation, endpoint-owned output limit); Runtime and Host builds pass.

Restart also exposed a background-maintenance recovery race: plugin activation could submit into an existing Session before its Root Turn admission tip was recovered. This admitted two erroneous additional roots into the isolated test database. Backed up that database, repaired only the two known predecessor links, disabled the old worker's automatic continuation and retained all original/event/index records. Added a generic Host guard rejecting plugin messages before recovery or during drain; its regression passes. The repaired isolated desktop boots successfully. Backup and exact repair audit are local test artifacts, not repository data.

At 17:12:36 Asia/Shanghai the same ordinary Sol Session retried `MemoryExtract` over its own selected record: 79 messages, approximately 294k characters of stored JSON. The tool arguments were only 802 characters. The plugin queries originals directly and passes them to the auxiliary model, without sending those originals through the parent Agent's transcript. This paragraph records dispatch, not successful generation or completed indexing; see subsequent observations before treating it as a passing live extraction.


First real extraction completed at **17:17:41**, after **305.610 seconds**. Receipt: **79/79 selected messages**, **311,544 input characters**, model-reported **134,633 input tokens / 5,744 output tokens**, **9,621 output characters**, `finishReason=stop`, **23 distinct supplied-source references and zero unknown references**. The parent's returned tool projection was **2,614 characters**, not the 311k-character source prompt. Full draft and exact receipt remained in the plugin's extraction directory. The executing Sol subsequently began reading the saved draft. No child Sessions were created by this ordinary Sol run.

The draft organizes three related voice-engineering events, preserves reported failures followed by later successful tests, and distinguishes historical assistant reports from direct tool evidence. This is evidence that the real extraction/return path works, **not** a completeness benchmark or proof that the 100-Session index is finished. The receipt and parent execution transcript are local private test artifacts. The endpoint's recorded zero dollar cost does not establish that the run is free; no cost comparison is claimed.
