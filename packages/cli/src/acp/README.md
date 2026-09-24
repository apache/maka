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
content and prevents that prompt from starting a Turn.

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
| Load/resume, replacing all MCP configuration, HTTP/SSE/OAuth | Deferred. |

The adapter saves the capabilities supplied during `initialize`. Missing form
capability, unsupported client methods, or invalid answers explicitly fail the
affected prompt and stop its exact Host Turn. Host owns interaction closure and
the canonical answer, including externally answered or replayed requests. Client
requests are fenced by Session, interaction, Turn/run, and attachment lifetime;
cancel and EOF release local waits even when the client never responds.
After a failed Stop, a cancelled Turn stays fenced even if its ACP prompt has
returned; only an authoritative terminal observation or attachment closure
releases the fence. An idle attachment does not present another client's Turn
interactions through this ACP connection.

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
