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

# ACP live Session behavior

The adapter retains a Runtime Host subscription after the first prompt. Cancellation
and close use the subscription's current root identity, including a Turn started by
another Host client while the ACP attachment was idle. Close releases the subscription
and connection-local ownership; it does not delete or archive the durable Session.

ACP v1 message chunks are append-only. Matching replay and prefix extensions are
supported. If a completed or recovered message changes text or thinking that was
already streamed (including clearing it), the adapter rejects the prompt with
JSON-RPC error `-32603` and `error.data.code: unsupported_stream_revision` and requests
a stop of that prompt's exact live root. It never represents a replacement by inventing
a new message ID or reports `end_turn` for that failed projection. The client may
still display the already delivered partial text; ACP v1 cannot retract it. The
Session remains owned and can accept another prompt or be closed.

Local resource links must identify regular files. Filesystem admission rejects
non-regular files, including POSIX FIFOs, before reading their content.
After live attachment succeeds, the adapter uploads each linked file through the
Host's existing Session Artifact protocol and uses its canonical attachment
reference for Turn admission. Cancellation or close during an upload aborts staged
content and prevents that prompt from starting a Turn. Loaded history renders each
stored attachment as a text placeholder with its name, media type and byte count,
including attachment-only user messages. The chunk preserves the canonical
references in `_meta["_maka/attachments"]`; it does not load attachment bytes.

When a dispatched start loses its response, the adapter retries admission queries
with bounded deadlines instead of replaying the start. Only a matching Turn or
authoritative `not_found` settles admission. Exhausted reads report `outcome_unknown`;
explicit cancellation still returns `cancelled`, with the failed Stop diagnostic
retained. Shutdown can cancel an initial attachment waiting for transcript hydration
or reconnection without waiting for the Host to become available.

## Capabilities

| Feature | ACP v1 behavior |
| --- | --- |
| Session create, list, configure, prompt, cancel, close | Supported through the shared Runtime Host connection. |
| Tools | `tool_call` and cumulative `tool_call_update` snapshots. Host `toolUseId` is the stable `toolCallId`. |
| Questions | Requires the client to advertise `elicitation.form`; each question is an optional string field with option hints and free answers. Missing, blank, or declined answers remain unanswered; cancellation cancels the Turn. |
| Forms | Standard `elicitation/create`, preserving string, number, integer, boolean, enum and multi-enum types and constraints. Defaults are hints, never automatically submitted. Decline and cancel remain distinct answers. |
| Sandbox boundary and client capability approval | Standard `session/request_permission`. The `allow_always` choice explicitly grants only the displayed scope for this Session; `reject_once` denies it. Permission cancellation cancels the Turn. |
| MCP | Session-owned stdio servers supplied in `session/new.mcpServers`; discovered tools and MCP form continuation use the existing MCP manager and Host capability path. |
| Tool `permission` | Standard `session/request_permission`. One-shot allow/deny choices are preserved; eligible tool permissions also expose an explicit allow-for-this-Turn choice. Permission cancellation cancels the Turn. |
| Load/resume | `session/load` replays durable user, assistant, thinking and tool rows before returning; `session/resume` attaches without replay. Both return current configuration and leave the Session attached for prompt. Neither restarts an interrupted Turn. |
| Explicit interrupted Turn resume | `_maka/turn/resume` queries the Host safety plan and starts only a ready plan. A required MCP tool absent from the current Session binding leaves the plan parked. A parked plan is returned unchanged. A lost dispatched start returns `outcome_unknown` with the exact `turnId`; the adapter never retries that command. |
| Goal control | `_maka/goal/query`, `_maka/goal/arm`, and `_maka/goal/control` forward Host projections and exact Goal identity, revision, iteration and token budgets. Arm stores a Goal; a normal user prompt begins its first work Turn. Resume can drive background work without another prompt. |
| Plan control | `_maka/plan/query` returns Host pages and `revision_changed`; `_maka/plan/control` forwards five actions with the caller's operation ID. `_maka/plan/turn/start` performs one Host approval or execution resume admission and returns `{plan, turn}`. Standard Session output and interaction notifications continue; `_maka/turn/status` reports a non-prompt Turn terminal state. |
| Copy source discovery | `_maka/session/copy-source/query` returns a bounded Host Turn page and `expectedSourceRevision` for an owned Session, so branch/revision parameters can be obtained entirely through ACP. |
| Branch and revision | `_maka/session/branch/create`, `_maka/session/revision/create`, and `_maka/session/revision/abandon` map to the corresponding Host commands. The source must be owned by this ACP connection. A committed target becomes immediately usable; `retained` keeps its ownership and `abandoned` releases local resources. |
| Replacing all MCP configuration | Every load/resume applies its complete stdio list through the existing Session MCP manager and publication. An omitted `session/resume.mcpServers` means an empty list. Equivalent normalized configuration reuses the process; changing or clearing it republishes the Session scope. An attached Session rejects a different configuration while the Host reports an active Turn; retry after that Turn settles. |
| Artifact query, upload, delete | `_maka/artifact/query`, `_maka/artifact/ingest`, and `_maka/artifact/delete` expose Host Artifact operations. |
| Memory query and mutation | `_maka/memory/query` and `_maka/memory/mutate` expose the Host bundle contract. |
| HTTP/SSE/OAuth MCP | Deferred. |

## Artifact and Memory request extensions

These are Maka-specific JSON-RPC requests over the existing ACP connection. The
params and results are the Runtime Host typed shapes. They are available to
clients that explicitly call them; ACP v1 does not define standard Artifact or
Memory capability fields. Only these five method names are registered. Unknown
methods return `-32601`; malformed params return `-32602`. An optional ACP
`_meta` object is accepted and omitted before strict Host input validation.

| Method | Accepted `kind` values or input |
| --- | --- |
| `_maka/artifact/query` | `list_start`, `list_continue`, `get`, `read_text`, `read_binary`, `read_chunk` |
| `_maka/artifact/ingest` | `begin`, `chunk`, `commit`, `abort` |
| `_maka/artifact/delete` | `{ "sessionId": "...", "artifactId": "..." }` |
| `_maka/memory/query` | `state`, `entries_start`, `entries_continue`, `document_start`, `document_continue` |
| `_maka/memory/mutate` | `remember`, `propose`, `approve`, `reject`, `set_status`, `reset`, `restore_backup`, `replace_begin`, `replace_chunk`, `replace_commit`, `replace_abort` |

For example, after creating an ACP Session, upload bytes in chunks and read the
committed Artifact without any Host-local file path:

```json
{"method":"_maka/artifact/ingest","params":{"kind":"begin","sessionId":"SESSION","uploadId":"CLIENT_UUID","name":"report.bin","mimeType":"application/octet-stream","totalBytes":5,"contentSha256":"sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"}}
{"method":"_maka/artifact/ingest","params":{"kind":"chunk","sessionId":"SESSION","uploadId":"CLIENT_UUID","offset":0,"chunkBase64":"aGVsbG8="}}
{"method":"_maka/artifact/ingest","params":{"kind":"commit","sessionId":"SESSION","uploadId":"CLIENT_UUID"}}
```

The `committed.attachment.ref` is a `session_file`. Its `relativePath` is
the canonical `artifactId`. Pass that ID and the same `sessionId` to
`_maka/artifact/query` with `kind: "get"` or `"read_chunk"`. For a complete
export, start at `offset: 0`, append decoded `chunkBase64` bytes, and follow
`nextOffset` until it is `null`. `read_text` and `read_binary` are bounded
previews and can report failure; they are not complete export methods. List
continuations retain the returned `revision` and `nextCursor`; a changed
revision is a domain result that asks the client to start a new scan.

Artifact upload chunks are at most 48 KiB, read chunks at most 32 KiB, and one
uploaded attachment at most 50 MiB. The Host owns byte staging, checksum and
offset checks, upload identity, quotas and five-minute upload expiry. An open
upload is tied to its Host connection. Session close waits for its in-flight
Artifact requests and aborts known unfinished uploads; EOF closes the shared
connection and releases Host staging. A completed Artifact remains durable after
close. The adapter tracks at most 64 unresolved upload identities, releases
identities after definitive Host rejection or completion, and at capacity asks
Host to abort expired identities before admitting more. On reconnect, a prior
upload may be gone and the adapter drops old connection tracking; the client
must use a new upload identity. The adapter never resends an uncertain command.
An interrupted response reports `request_interrupted` with `reason` and
`dispatch`; if
`dispatch` is `dispatched`, inspect Host state before deciding what to do.
Protected execution evidence can reject delete with `operation_conflict`.

Real Read-tool image results expose a bounded `_meta.maka.artifacts` entry
with `artifactId` and `maka://runtime/attachments/...` reference, plus a
visible read hint. Use the Artifact query route with the card's ACP Session ID
to fetch it. Result text and raw output remain subject to normal truncation
and redaction rules; the Artifact bytes are not embedded in the tool card.

Memory queries operate on the Host Memory bundle: `state`, one revision-bound
page of active/archived/proposal entries, or a 32 KiB document chunk for
`memory`/`pending`. Continue with the returned revision and cursor. Semantic
mutations use `expectedRevision`; restore also requires
`expectedBackupRevision`. The multipart replace route uses Host upload IDs,
offsets and SHA-256 integrity checks. Domain results such as
`revision_conflict`, `backup_revision_conflict`, `rejected`, `blocked`,
`safe_mode`, `missing`, and `revision_changed` remain results, not generic
JSON-RPC failures. Host `commit_outcome_unknown` remains an operation error;
clients must query before deciding whether to submit another mutation. A
session-scoped `remember` or `propose` requires a Session
owned by this ACP connection. Entry and proposal ID mutations retain the Host's
bundle-level authorization boundary.

Host policy controls whether Memory can be read or written, including
`enabled`, `agentReadEnabled` and incognito state. A committed, readable
entry is added by the Host to a later applicable Turn's model input. It does not
rewrite a model request already running. The ACP adapter does not assemble
or inject Memory itself.

The adapter saves the capabilities supplied during `initialize`. Missing form
capability, unsupported client methods, or invalid answers explicitly fail a
locally admitted prompt and stop its exact Host Turn. For an attached Turn,
presentation failure leaves the Host interaction pending for a capable client.
Host owns interaction closure and
the canonical answer, including externally answered or replayed requests. Client
requests are fenced by Session, interaction, Turn/run, and attachment lifetime;
cancel and EOF release local waits even when the client never responds.
After a failed Stop, a cancelled Turn stays fenced even if its ACP prompt has
returned; only an authoritative terminal observation or attachment closure
releases the fence. An idle attachment created only by prompt does not present
another client's Turn interactions through this ACP connection.

After load/resume, the attachment observes an already running root Turn and its
pending interactions through the same Session channel and Turn mapper used by
prompt. A new Turn observed on that loaded attachment also uses this path.
Clients that advertise `initialize.clientCapabilities._meta["_maka/turnStatus"]:
true` receive `_maka/turn/status` notifications for non-prompt Turns after their
standard output has settled. Each notification names `sessionId`, `turnId`,
`runId`, and a `completed`, `failed`, `cancelled`, or `observation_failed` status.
Terminal snapshots are retained with their exact Turn's event queue until
consumption, including when a successor finishes before an output barrier releases
its observation.
Ordinary ACP clients can load/resume and prompt without this extension.

## Goal and Plan extension

The agent advertises `initialize.agentCapabilities._meta["_maka/goalPlan"]:
{ "version": 1 }`. All six requests require Session ownership obtained through
`session/new`, `session/load`, or `session/resume`. They use the Runtime Host
input and result shapes and preserve Goal budgets/revisions, Plan store versions,
entity IDs, operation IDs, and Turn IDs. Plan pages contain at most 16 items;
carry `storeVersion` and `nextCursor` into `list_continue`, and restart from
`list_start` after `revision_changed`.

Clients that set `initialize.clientCapabilities._meta["_maka/goalPlanStatus"]:
true` also receive `_maka/goal/status` with `{sessionId, goal}` and
`_maka/plan/changed` with `{sessionId, storeVersion, latestProposalId,
activeExecutionId}`. These are latest-state hints, not an audit log. Query Plan
for the full proposal, execution, and step projection. A client without the
notification preference can still use every request. Register notification
handlers before sending mutations: a Host change can precede its request result.

Both domain notifications use best-effort delivery: a rejected send is logged to
stderr and is not automatically retried. Without a later domain update or
canonical replacement, the client may keep an older view; use `_maka/goal/query`
or `_maka/plan/query` to recover authoritative state. The bounded backoff applies
only to failed Host reads while refreshing Plan hints, not notification sends.

Successful mutation responses mean Host admission, not task completion. A lost
dispatched response returns `error.data.code: outcome_unknown` with the original
Session and available entity/operation/Turn identity. The adapter never resends
the command. Query the Host before a new user decision; equal Goal condition and
budget do not identify a prior arm. Host `persistence_failed` remains distinct
and keeps the observation alive for later authoritative facts.

`goal.control.pause` controls Goal continuation, while `session/cancel` stops
the current observed Turn. `plan.control.cancel_execution` changes Plan state;
the Host can reject it with `session_busy` while a root Turn is active. Closing
the ACP Session releases this connection's resources and does not clear the
durable Goal or Plan.

The working directory in load/resume must resolve to the Session's Host cwd;
additional directories are not supported. Missing and archived Sessions are
rejected. A repeated successful load replays history again on the same retained
attachment. Historical pages are read through that attachment's subscription,
so they do not consume a second Host subscription slot.

The Runtime Host composes the model prompt from its current policy, including
workspace instructions when enabled. ACP clients provide user prompt content;
`session/load` and `session/resume` do not replace the Host's system prompt or
workspace instruction policy. The Host records model usage and context window
facts in its runtime data, but this ACP v1 adapter does not emit a separate
usage or context-window notification. An ACP client's own usage display should
not infer those numbers from replayed text chunks.

## Branch/revision source discovery

After creating or loading a Session, call `_maka/session/copy-source/query` with:

```json
{
  "sessionId": "source-session-id",
  "throughSequence": null,
  "position": 0,
  "maxContributions": 64
}
```

The response contains `sessionId`, `expectedSourceRevision`, `throughSequence`,
`contributions`, and `nextPosition`. Each contribution contains a `turnId`,
`firstSequence`, a bounded `userPromptPreview`, and `latestState` when available.
To continue, carry the returned `throughSequence` and use `nextPosition` as the
next request's `position`; `null` ends paging. The Host limits each page to 128
contributions. A Turn can contribute to more than one page: merge by `turnId`,
retaining the earliest `firstSequence` and the greatest `latestState.sequence`.
Select a settled Turn after reading its state, rather than guessing a boundary
from a text message ID. No additional subscription is opened by this query.

Pass the selected `turnId` as `sourceTurnId`, the query's `sessionId` as
`sourceSessionId`, and `expectedSourceRevision` unchanged to branch/revision
creation, together with a new `targetSessionId`. The Host still validates the
boundary and revision. If the source changes, `source_revision_conflict` requires
an explicit refresh and a new client decision; the adapter does not retry copy
commands. An empty source can be branched only with the Host's explicit
`intent: "side_conversation"`; it cannot be used for revision creation.

Cancelling a load/resume or explicit Turn-resume request while its initial
subscription opens or hydrates releases that request's wait immediately. If no
other request is awaiting the same attachment, initialization is aborted and a
late subscription is closed. A concurrent prompt or restore retains its own
wait and prepared Session resources. This does not stop an already attached
Host Turn; use `session/cancel` for that operation.

## Tool output and completion

ACP projects Runtime Host tool activity as `tool_call` followed by cumulative
`tool_call_update` snapshots. Output, progress and previews update one card,
including when start arrives late. Input previews are labelled as previews. A
complete authoritative result replaces the live output. `contentOmitted` preserves
the existing display and requires transcript reconciliation. Raw input/output is
omitted when completeness cannot be established or its presentation would exceed
the limit. Late progress cannot reopen a terminal tool; authoritative results may
still correct its content. A tool without a result is marked interrupted without
replacing its last displayed output. Only an announced result without a matching
durable record fails a completed prompt.

Each tool retains at most 64 Ki characters and 512 chunks of presentation state.
Truncation is visible, and detected live output sequence gaps are marked. A
prompt may retain at most 1 Mi characters and 4096 tool identities; exceeding
either limit deliberately fails projection, rather than discarding another tool's
presentation. Terminal delivery
releases large payloads and retains bounded identity/digest information.

Before `turn.start`, the Session channel captures a transcript watermark. On
settlement and before successful prompt completion it rereads the target Turn to
the announced upper watermark, using the same subscription's paged transcript and
fragment decoder (the existing 16 MiB range assembly budget applies). Recovery
invalidates reads from the old subscription and starts again at the original cut.
This does not consume another subscription slot. Missing announced results, failed
reads and failed notifications prevent `end_turn`; cancellation and failed Turns
do not wait for missing results. An explicit cancellation still returns `cancelled`
if a notification had already failed. Only the channel decides Turn terminal state; the
registry waits for final projection delivery before returning `end_turn`.

## Session MCP ownership

The executable must be an absolute path. Duplicate server/env names, malformed
args/env and unsupported transports are rejected before starting processes.
Processes use the Session's working directory and the manager's existing
environment, credential exclusion, log redaction, discovery and cleanup behavior.
The configuration stays in memory and never edits user MCP settings.

Creation generates an ID, prepares and validates every requested server, publishes
the Session-scoped capabilities, then dispatches Host `session.create`. One failed
server releases the entire prepared group. A confirmed creation always returns its
ID even if optional configuration presentation fails. If the dispatched creation
response is lost, the error includes `sessionId` and `dispatch: "dispatched"`; the
adapter retains the connection-local reservation and MCP resources. The client can
continue with that ID or close it; creation is never silently retried.

Different Sessions can use the same server/tool names with different processes.
For the same Session, ACP publishes a SHA-256 identity of the complete normalized
MCP configuration. Host atomically rejects a second provider with a different
identity, including an empty configuration, before changing registration state.
Load/resume reports `error.data.code: session_binding_conflict` for incompatible
configurations; restore with the same configuration or close an active conflicting
attachment. Equivalent configurations remain attachable, including live permission
restoration. A disconnected frozen Session binding can be reclaimed by another
local-owner connection of the same authenticated principal with the same complete configuration
and contract set. This optional wire field and its typed conflict use
Host compatibility epoch 185.
Registration replacement, unregister, disconnection and invocation routing respect
the target Session and owning connection. A default registration and its target
Session registration may not expose the same tool identity. Another Session cannot
borrow the registration through provider fallback. Reconnection republishes the
current tool snapshot without replaying calls, and prompt admission waits for the
current connection and tool revision to be published.
An empty snapshot is published too: it clears contracts lost during disconnection
and retains the Session retirement notification. Empty registrations share the
same per-provider limit as registrations with tools and are released on close.
Host publication checks durable archive/removal state inside its mutation queue;
never-created Session IDs remain valid for preparation, but retired IDs cannot
be republished. Unarchiving permits a fresh publication.

Generic MCP `ask` approval uses `admission: "mcp"` and the existing atomic Session
grant mechanism with `mcp_tool` scope. It does not elevate provider trust or grant
Host path access. Desktop MCP continues to use its existing capability. These wire
changes move the Host compatibility epoch from 175 to 176; grant storage needs no migration.
Close/EOF stops execution, releases subscriptions, unregisters the corresponding
capabilities and closes MCP transports before closing the shared Host connection.
The stdio transport stops its direct child; launchers that spawn further processes
must arrange for those processes to exit themselves.
If a server exits after creation, its tools are withdrawn and later prompts may
continue with the remaining published tools.

For a Zed custom agent, configure an absolute Maka executable with `args: ["--acp"]`
under `agent_servers`, following [Zed's external agent documentation](https://zed.dev/docs/ai/external-agents#custom-agents).
The standard tool and permission flow does not require a private ACP route.
