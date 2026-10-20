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
one configured executor instance,
cached for 60 seconds, and invalidated on setup/login, explicit refresh, or provider replacement.
A refresh affects that executor's draft candidates; it never mutates a retained task.
The scratch path is stable across refresh, TTL expiry and Host restarts, scoped to the data root,
Plugin namespace, adapter and composition Entry. A native file lease serializes owners across
runtime instances and processes. Probe processes are drained before directory contents are removed
and the lease is released. A later owner clears residual contents after a crashed Host releases
its OS lease. Direct `AcpExecutor` embeddings without Host storage reuse a temporary path only
within that executor's lifetime; supply `withCatalogDirectory` for durable directory ownership.

The ACP runtime Entry shares a two-probe FIFO budget across its adapter registrations, using
Runtime's existing AdmissionLimiter. The permit covers initialization, connection disposal and
temporary-directory removal. Replacement probes wait for superseded probes to finish cleanup;
queued probes are cancelled by invalidation or disposal. Individual callers can stop waiting
without owning a shared probe. Pending callers follow invalidations to the current revision even
when setup/login does not start a replacement query. Genuine probe failures do not automatically
retry, and cancellation or disposal stops the caller. The 30-second probe deadline includes time waiting for capacity.
No additional Host protocol or Agent-specific Desktop discovery path is required.

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
