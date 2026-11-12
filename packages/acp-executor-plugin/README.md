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

# ACP Executor Runtime Plugin

This package is the shared ACP transport and lifecycle layer. It provides `ctx.acp` to child Plugin
Entries. An external Agent package supplies only an `AcpAgentAdapter`; the service turns that adapter
into the generic executor contribution introduced by #5283.

Installing this package creates the `acp-runtime` profile Entry. Keep adapter Entries below it so the
service follows normal Plugin Context inheritance. The Host remains unaware of ACP and sees only
`ctx.executors` registrations.

Adapter packages register with `ctx.acp.register(ctx, adapter, config)`. Passing the adapter Entry's
Context explicitly is part of the package ABI: production packages are separate self-contained
bundles, and the shared runtime must register the executor against the consumer's scope rather than
against its parent Entry.

## Draft catalogs and task configuration

ACP draft discovery uses an empty, stable scratch directory owned by Plugin storage. It never passes the selected
project to the Agent's session/new request, sends a prompt, or writes task continuity. Maka does
not inspect project files to construct this catalog. Candidates are shared across projects within
one configured executor instance. Successful catalogs have no time-based expiry and are persisted
through namespaced Plugin storage. Versioned snapshots bind to configuration, launch arguments,
platform and executable/helper metadata; missing or incompatible snapshots trigger discovery.
Standalone embeddings opt into disk reuse with `catalogPersistence: { storage, key }`.
Setup/login and provider configuration changes invalidate the affected catalog. Explicit refresh
requests a new probe while retaining successful choices on transient failure; it never mutates a
retained task. Cold discovery failures have a 60-second retry cooldown, bypassed by explicit refresh.
The draft picker exposes a **Refresh models** action only for the selected ready external Agent.
New drafts using a native model do not show it. Account and remote model changes reach the public
catalog through explicit refresh or setup/login invalidation, without a periodic discovery timer.

Only neutral discovery may populate or persist the public catalog. Real Session initialization,
restoration, configuration changes, and notifications update that Session's own capabilities,
read through conversation inspection. Project-specific models, selections, and modes never replace
another project's draft choices or the shared snapshot. Even when a task starts first, the first
uncached draft still needs one neutral probe. Snapshot version 2 rejects older snapshots that may
contain Session-specific candidates. Refresh errors are not persisted, and invalidation fences
pending disk reads and probe results.

`CATALOG_SNAPSHOT_VERSION` in `src/acp-catalog-store.ts` versions both the storage
format and the derived catalog semantics. Increment it whenever `#catalogEntry`,
catalog normalization, or an adapter's display name or `describeModels` changes
persisted labels, model groups, provider types, defaults, or capabilities. This
includes changes in adapter packages such as `@maka/antigravity-acp-plugin`, even
when the Agent executable and launch configuration are unchanged. Old snapshots
then trigger one neutral discovery and are replaced with the current derivation;
subsequent restarts reuse the refreshed snapshot. Unrelated Maka updates need no
version bump. This is an explicit maintenance contract, not automatic code-change
detection.

After initial disk hydration, cache hits do not read or write storage. Every successful neutral
probe checks the current executable/helper metadata and persists its result, even when its model
list is unchanged. This keeps the snapshot bound to the refreshed installation after an in-place
binary update.

The scratch path is stable across refresh and Host restarts, scoped to the data root,
Plugin namespace, adapter and composition Entry. A native file lease serializes owners across
runtime instances and processes. Probe processes are drained before directory contents are removed
and the lease is released. A later owner clears residual contents after a crashed Host releases
its OS lease. Direct `AcpExecutor` embeddings without Host storage reuse a temporary path only
within that executor's lifetime; supply `withCatalogDirectory` for durable directory ownership.

The ACP runtime Entry shares a two-probe FIFO budget across its adapter registrations, using
Runtime's existing AdmissionLimiter. The permit covers initialization, connection disposal and
temporary-directory removal. Replacement probes wait for superseded probes to finish cleanup;
each executor therefore retains at most one probe owner, including after cleanup failure.
Queued probes are cancelled by invalidation or disposal. Individual callers can stop waiting
without owning a shared probe. Pending callers follow invalidations to the current revision even
when setup/login does not start a replacement query. A failed request does not loop; later automatic
reads can retry after the cooldown. Cancellation or disposal stops the caller. The 30-second probe
deadline includes time waiting for capacity.
The generic executor query supports process-free inventory and per-executor discovery/filtering;
no Agent-specific Desktop discovery path is required.

Draft candidates are advisory. The existing retained Session path initializes in the task's real
workspace and validates the requested model, then its dependent mode, before sending any prompt.
Unavailable explicit values fail instead of silently falling back. Omitted values use the real
Session defaults. Inspection, confirmed selection, rollback and restart continuity remain
independent of the draft cache. Workspace-dependent options can therefore differ from the draft
probe and require the user to choose again.

The configured Agent remains a trusted local process. Disabled client filesystem/terminal
capabilities and a neutral cwd are not an OS sandbox. Maka closes probe connections and cleans
its scratch directory, but cannot guarantee deletion of Agent-owned empty Session history.
Native history deletion depends on the Agent's private storage format and belongs in a verified
adapter-specific implementation, not the shared ACP runtime.
