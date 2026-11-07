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

# maka-event-log

[简体中文](README.zh-CN.md)

Checkpoints use `RootStore::history_checkpoints` and the types in
[`checkpoints`](src/checkpoints.rs). Capture freezes event membership, source
boundaries, artifact references and export metadata in the runtime database.
The manifest commits to a native Bundle reconstructed from that snapshot;
validation uses a temporary transfer file. The manifest and optional Workspace
file objects live under the private Root. Checkpoint Head, snapshot publication
and the publication receipt commit in one database transaction; Host operation
settlement resolves that receipt separately.

The original operation binds its inputs and captured snapshot. Startup
interrupts unfinished capture and resumes prepared publication from the same
snapshot. Failed or deduplicated unpublished captures release their independent
snapshot references. Snapshot membership pins canonical event material and
artifact content independently of live Session changes or collection. Exact
checkout accepts only the current Head revision and reconstructs its committed
transfer bytes. Historical publication receipts do not grant checkout of
superseded revisions. Temporary-file cleanup is recorded separately from
publication success.

`HistoryCheckpoints::load_exact` verifies the exact current Head and its origin,
then records a load receipt referencing the existing immutable snapshot in the
same database. It creates no Session, import or inspection database. Bounded
history and artifact queries use snapshot ownership and preserve historical
identities without exposing live execution capabilities. Replaying the load
operation returns its original receipt; loaded history remains readable after
Head advances.

Checkpoint file publication currently requires Unix file/directory durability.
It has no automatic trigger, wire endpoint or cross-Root execution handoff.
Native transfer formats are distinct from the legacy TS compatibility bundle;
Workspace capture and same-Root directory recovery are described below.

Transcript rows expose separate `position` and `order` addresses. `position` locates canonical source content; `order` places a native assistant message at its actual start even when its end arrives after a tool call. Indexed history paging, navigation and copied history use display order while source reads and fences retain canonical provenance. Native message bodies are reconstructed through invocation/message-specific indexes, not by rescanning all earlier tool output.

Stores initialize through the current SQL migrations. Unsupported internal layouts and record formats are rejected. Canonical facts and their acceptance, ownership, recovery and budget indexes share the original transaction. Transcript and Recall read models belong to the disposable observation cache.

Owns the SQLite event store and State Root lease. It persists application sources and packages, operation receipts, sessions, turns and recovery records. Start with `root` for exclusive ownership, `applications` for committed compositions, and `recovery` for interrupted work. Opening a Root establishes the durable owner before services activate; plugins keep their own policy while this crate records canonical facts.

Production opens `RootStore` with one exclusive `RootOwner` and one runtime database. Application sources and packages, caller intent journals, project/workspace bindings, Sessions, operation journals and scoped plugin data share that database. `SessionStore` and `OperationStore` bind access to their admitted identities; sharing storage does not grant access to another Session or source.

Public APIs remain asynchronous. They enqueue owned commands to actors whose dedicated threads open, exclusively own and close synchronous `rusqlite::Connection` handles. One writer FIFO serializes mutations; independent reader lanes see committed snapshots, and the observation lane owns its disposable cache. SQL, row decoding and transaction cleanup run on the owning thread. SQLite rows, statements and borrowed BLOB data stay inside that job.

CPU-heavy write preparation uses a bounded worker pool and admission capacity. The request reserves its writer FIFO position before preparation starts, so preparation completion cannot reorder accepted writes. Interruptible reads install a per-job SQLite progress hook: observer cancellation marks that read, and the hook is removed before cleanup and connection reuse. Accepted writes retain their original custody through physical transaction cleanup even if the observer disappears.

Idle handles and completed capabilities hold weak storage references. A live execution carries its captured permission basis, binding pins and Session work lease through tools and Host child scopes; child workers fork that real custody when they can outlive their parent. Root shutdown stops admission, drains accepted work, joins reader and preparation threads, and waits for physical closure of all SQLite connections. Close completion reports the actual `Connection::close` result. A live handle that fails to close retains its authority and reports failure; dropping an observer is never proof of cleanup.

Workspace relinking changes one shared binding and its revision offsets, without rewriting all Sessions. Metadata CAS reads the effective revision. Relinking excludes active work on the affected bindings; retirement also waits for operation auxiliary work. Auxiliary admissions, source pending checks and once-only records remain in the source journal's transaction. Startup recovers abandoned effects and auxiliary work before exposing Root readiness.

Root catalog and usage queries use indexed keyset pages in the runtime database, excluding unpublished or hidden Sessions in SQL. Accounting activity and breakdowns use keyset cursors; physical facts are counted once even when conversation history is copied. The Goal token meter maintains per-Session totals in the settlement transaction, so ordinary budget checks use indexed totals without rescanning history. Session notifications register only active observers and publish keyed changes after commit.

Model requests capture immutable canonical sources through Session execution custody. The Engine freezes rendering decisions and owns request preparation; the event log supplies bounded source reads without a private prepared database. Session scratch state and loaded-tool state use the disk-backed `maka-session-state` backend. Model context compaction bounds the selected working window without deleting canonical conversation history. After adoption, model context contains the historical checkpoint summary followed only by events after `covered_through`; the covered opening message is not replayed. Opening identity still validates MidTurn checkpoints. Attachment locators retained in summaries resolve through the copied Session’s existing ownership mapping.

Larger semantic payloads use [SQLite rowid tables](https://www.sqlite.org/withoutrowid.html#when_to_use_without_rowid), addressed by explicit logical primary keys, for more inline record space.

Caller intents, project registrations, workspace attachments, Session reservations/publications, operation dispatch and settlement, pending messages and eligible canonical appends share the typed writer queue. At most 32 already queued adjacent requests share a FULL commit, without a collection delay or crossing an ordinary writer command. Each request keeps its own validation; groups with multiple requests isolate each request with a savepoint. Durable receipts, execution claims and commit notifications are released only after successful commit. Dependent producer stages await the preceding durable receipt. Capability, checkpoint, summary and lineage appends retain their original transaction path.

New runtime events use UUIDv7 identities to keep event and derived message index writes local. Imported and replayed identities remain unchanged, and database sequence remains the ordering authority. Semantic event-identity lookup indexes only tool results, which need it for archival; incremental revision reads use the change directory, while historical source copies seek the source-position primary key.

Canonical runtime-event ingress inserts each event, captures its sequence, then maintains safety, execution, source and semantic projections as separate statements on the same writer actor and transaction. The shared insert statement derives indexed accounting and owner fields from those same JSON bytes; collection preserves their published values when removing retired bodies. Typed facts select the safety and execution statements to run. The next event cannot begin before those projections finish. Projection storage failures roll back the entire batch, including imported events; notifications remain tied to successful commit. Copied-prefix projections are maintained by their current copy paths.

Canonical databases use UTF-8. Successful tool results store their original `model_projection` token separately: `event_header` preserves every surrounding byte with a literal `null` placeholder, and the event row records the original byte offset and immutable body reference. Reconstructing the header and original token reproduces the exact canonical event, including imported whitespace, number spelling and Unicode escapes. `canonical_bytes` supplies logical byte budgets; encoded size never substitutes for admitted canonical size. Other event kinds remain inline.

Bodies are directly seekable raw bytes, shared by SHA-256 of their original token with exact byte comparison on a repeated identity. Reads validate logical lengths and selected ranges. Framed compression was evaluated against raw storage and rejected because it repeatedly slowed supported window and sequential reads; it is not a persisted format. Space savings come from compact directories and sharing identical projection tokens, not from compressing unique bodies.

Complete-event JSON queries join the referenced body into the selected SQL row within the original snapshot and reconstruct the original bytes. Typed prefix readers order headers and body references, keeping large payloads out of SQLite's sort records. One prepared primary-key lookup resolves each referenced body on the same connection and transaction; inline events require no body lookup. Readers decode the borrowed header and original projection bytes directly on the connection-owning actor. They avoid copying the body into a temporary string and finish decoding before advancing either row. The existing event/byte preflight and transaction cover the complete result; no SQLite borrow or unfinished decoder leaves that actor. Typed headers reuse fact field types and defaults, ignore unknown metadata, and verify that the projection placeholder is exactly at its stored offset. Root evidence hashes the three original byte slices as one length-prefixed JSON field. Metadata predicates use the header and retain their indexes. Semantic spans retain original canonical coordinates; tool spans translate those logical coordinates into offsets within their immutable body, while inline model parts retain physical SQLite BLOB bounds. Resolution stays on the connection-owning actor. Hot range reads use its existing prepared-statement cache. Body references follow the existing history-owner collection proof; clearing or deleting the final reference removes its body in the same transaction. The event row publishes the header, logical length, offset and reference atomically; live references cannot be redirected. Neither a body digest nor a derived directory grants access or extends lifetime. Derived archive placeholders and other fragment bodies keep their chunked storage.

Semantic row, payload and child directories are finite derived descriptors encoded with Postcard. Writers encode them once in the publication transaction. Pages copy their stored bytes alongside fixed little-endian locator fields into the caller's charged allocation; consumers decode the original typed descriptors without navigating whole bodies. Original byte positions and leaf commitments remain unchanged. Directory encoding never supplies a canonical fact or source identity.

`event_storage_bench` exercises real Root writes, captured directories, child pages, first/tail and repeated 64-byte windows, sequential bodies, event prefixes and bundle export. Build the same example in release against both revisions and retain each binary, then run `python3 scripts/bench-event-storage.py --output /tmp/storage-comparison original=/path/to/original candidate=/path/to/candidate`. It alternates at least five runs and validates event, descriptor, body and export digests. The first read pass validates and warms caches; reopened measurements are OS-cache-warm. Raw distributions, process CPU/RSS/I/O availability, SQLite cache counters and separate main/WAL/SHM file sizes are recorded. Live prepared-statement snapshots do not represent total SQL work, and JSON/text/content leaf reads and settlement writes are also reported separately. Use `--body-pattern entropy` to include deterministic low-compressibility printable input.

`prefix_read` stops when the prefix API returns; `prefix_all` also includes reserialization and full result digest verification. Keep both when interpreting a difference. `--operation prefix` restricts measured iterations to consecutive prefix reads while retaining the first complete validation/warmup pass and every prefix oracle; use the same option in both binaries. This is an OS-warm focused workload, distinct from the default mixed-operation loop.

A statement failure rolls back the writer group unless a domain rejection is isolated by its request savepoint. Reuse requires acknowledged rollback, autocommit state and valid ownership. Failed commits return unknown outcomes without execution claims; unconfirmed cleanup retires the connection. Single-key and paged plugin-data reads use independent reader connections and see committed snapshots; dependent reads await their preceding write receipt.

Saved application inspection uses `RootOwner::open_existing` and `EventLog::for_application_inspection`. It requires existing private coordination state and the original exclusive Root/database leases, reads committed application facts including retained WAL content, and closes without changing stored members or bytes. It performs no migration or derived initialization; missing state fails without repair. Only application queries on the owned connection belong to this opening. CLI application read and default-update preview share it; applying an update opens a fresh ordinary writer and recomputes the change.

Original operation contracts are stored once by digest. Operation requests and receipt references carry that identity, so journal reads, caller history and UI delivery do not repeatedly copy service schemas. Reads verify the exact original request fingerprint; admission still validates the complete contract and resource requirements.

The operation journal retains complete admitted requests and returned values without separate request, result or receipt-reference size quotas. Exact retries and reopened readers recover the original outcome and cleanup status.

Message delivery retains prepared content, the editable original and the original submission digest. Its internal records can exceed the public request envelope because they preserve these separate facts; writes and exact message reads do not reapply that envelope to the encoded record. Pending queues have no fixed message-count or aggregate-byte quota. Stop and whole-queue retraction retain complete admitted entries in their transactional receipts, without a separate receipt-size quota. Exact retries and reopened readers return the same original receipt. Use `editable_message` to read one owned source by its Session, Turn and message identity.

Source messages, executor tool calls and generated tool results share the Session's visible-message identity namespace. Admission checks both claim orders against canonical facts, including results synthesized for pending tools at executor completion or invocation termination. Only actual result identities are occupied; a matching suffix alone does not reserve an identity.

Canonical ingress appends fixed-size SHA-256 chain roots for native Session, Invocation and database sequence prefixes in the same transaction. Immutable copied-prefix references pin admitted parent identities. Source identity binds scope and cut to selected prefix roots; lineage binds its base Session prefix, a persistent linked ancestry root and the current Invocation prefix. Each new opening adds fixed-size lineage metadata; ordinary source identity reads use the pinned ancestor root. Historical cuts and SQL membership selection may traverse compact linked metadata without retaining an ancestor vector in Rust. Imported copy membership must exactly match its claimed complete source prefix. Effective context identity adds the copied archive-pin prefix and only selected archive overlays admitted after the source cut. Earlier native archives are already committed by the source root and are not rescanned or revalidated on ordinary requests. Copy ingress freezes archive-pin prefixes once; historical source cuts select their indexed prefix independently of the exclusive archive fence.

A continuation checkpoint can serve later whole-Session requests when its selected history covers the complete Session prefix at the checkpoint cut. Coverage compares indexed cumulative event counts for the Session interval and ancestor Invocations; it does not read event bodies or persist another conversation head. Narrower checkpoints remain local to their lineage, so intervening branches are never discarded.

`run_source` reads the durable Invocation prefix and its opening/final endpoints. Its identity binds Run-local event count, Invocation identity and committed ordered source root. Ordinary lineage selection reads the immutable descriptor installed with the opening. New continuation admission still checks ownership, claims, workspace identity, exact sealed endpoints and unresolved effects; source roots never grant execution authority.

Ordinary requests and normal reopening trust facts and checkpoints admitted by the controlled writer or import boundary. They read fixed semantic views without a canonical tail, writer confirmation handshake, process-local trust certificate, raw payload binding rescan or recursive checkpoint reauthentication. New checkpoints validate their new source/predecessor edge and required terminal conditions. Arbitrary direct SQLite rewriting is not a supported editing API and is not detected on ordinary reads. Explicit bounded history exports retain their event/byte preflight limits.

The observation actor builds transcript metadata and contentless Recall postings in its private temporary SQLite database. It captures canonical membership and a source fence, then adds only newly eligible sources; zero-row sources also advance progress. Rows, source failures and progress share one cache transaction. The canonical database remains physically read-only on this connection. Projection failures are reported by history or as explicit search gaps, while storage failures roll cache work back; neither becomes an execution-fact rejection.

Recall stores one [FTS5 posting](https://sqlite.org/fts5.html#the_detail_option) per distinct gram and document, using grams of one, two or three Unicode scalars. After NFC normalization and lowercasing, literal OR matches are ranked by non-overlapping matched Unicode scalars divided by text scalars; overlaps between terms count separately and tool results have half weight. Results retain one best matching message per Turn, stable timestamp/identity ties, and the requested limit. FTS identities reuse the directory rowid; candidate text and attachments are rendered from their canonical source for literal verification.

Item-accepting main parts retain their original observation sequences, identities and ordinals. Historical cuts remain immutable. Directory and FTS metadata survive ordinary body-cache eviction, independently of the existing 32 MiB retained-body target. Copy identity changes and session purge invalidate the affected private cache; closing the observation connection discards it. The next read rebuilds the requested canonical range, without a writer-side directory installation or startup maintenance step. Only canonical ownership and material references decide access and collection.

Whole-artifact reads use `with_artifact` with Session or execution-turn scope. Metadata and one local read-only BLOB reader share the original owner's snapshot; the synchronous callback owns its destination, and the reader closes after it returns, before the snapshot is released. This avoids reopening and rereading the payload for each chunk. The independent read owner retains that snapshot; accepted work retains the original owner even if its waiter disappears. Attachment copies stream fixed-size BLOB chunks from a frozen source snapshot into one target transaction, including digest verification and idempotent retry checks. Callers retain their resource budgets, digest checks and cancellation policy. `read_artifact_chunk` serves independent windows; repeated windows do not retain a sequential cursor.

Generated tool images and user uploads retain their complete original artifact bytes through model reconstruction, immutable copies and bundle transfer. Payload length, digest, canonical retention and copied-history mappings remain authoritative. Bundle transfer streams blobs in chunks and retains physical frame-length representation and stalled-I/O cleanup, without an independent whole-bundle content quota.

History, delivery and resource pages retain their byte targets for packing subsequent items, while one complete first item always advances with its original metadata and cursor. History body windows remain bounded UTF-8 transfers. `history_source` takes a body-byte target and returns the complete original metadata for that single chunk; it has no separate JSON-envelope quota. Session scope and frozen source fences remain mandatory.

Integration scenarios share `cargo test -p maka-event-log --test integration`; filter by module, such as `archive::` or `sessions::`. The cross-process lease check stays in `--test root_lease` because spawning a child temporarily inherits other test threads’ file leases. Private projection tests run with `--lib`.

[Source](src/lib.rs) · [Cargo manifest](Cargo.toml)

Startup recovery reads all unresolved execution authority without a separate item or byte quota; completed history stays excluded. Tool-result payloads and frozen request compositions have no application-level storage size cap.


Workspace snapshots use a path inventory plus immutable file objects. Their
`caller_confirmed_quiescent` / `unverified` declaration is independent of byte
integrity and never claims external-writer fencing. Same-Root workspace restore
requires unchanged live history, materializes a new directory, and commits the
binding and original receipt atomically without advancing checkpoint Head or
starting execution. See the [Agent API](../../plugins/agent/api/README.md#workspace-publication-and-local-continuation)
for the supported file policy, explicit warning, recovery and scope limits.
