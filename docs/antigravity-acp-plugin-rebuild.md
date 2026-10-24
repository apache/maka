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

# Antigravity ACP Plugin rebuild

## Basis of the Plugin implementation

The original PR #5224 proposal predated the Plugin-backed Session executor architecture from #5283.
It added a dedicated ACP backend and then threads external-Agent identity, model catalogs, session control, protocol
operations, Desktop bridges, and Composer state through the Host. That original approach changed 139 files and added roughly 7,800 lines.

The new architecture already owns those cross-cutting responsibilities generically:

| Concern | Original proposal | Plugin implementation |
| --- | --- | --- |
| Session routing | `AcpAgentBackend` registered in Host execution composition | `executorId` plus `PluginExecutorBackend` |
| Executor lifetime | ACP-specific Host residency and backend registry logic | Plugin Entry generation, retirement, and executor binding |
| Transcript | ACP event conversion plus new external-session fields | Generic executor events enter the canonical Session stream |
| Process and credentials | Runtime Host ACP module | Contributing Plugin; opaque to Maka Runtime |
| Child/Graph execution | ACP-specific guards | Generic executor propagation from #5283 |
| Model choice | Provider catalog protocol and ACP-specific Desktop state | Generic executor catalog/configuration consumed by Desktop and the Plugin backend |
| Permission choices | ACP backend reaches `HostedInteractionBridge` directly | Generic executor permission request bridged by `PluginExecutorBackend` |

Keeping both designs would create two backend authorities, two lifecycle paths, and provider-specific
state in otherwise generic Session and Desktop code.

## Rebuilt boundary

The rebuild is split into an intermediate runtime and a thin product adapter:

```text
PluginExecutorService
  -> ACP Runtime Plugin (`ctx.acp`)
       -> Antigravity adapter
       -> future ACP adapter
```

`@maka/acp-executor-plugin` owns the shared ACP protocol implementation. Its `acp-runtime` profile
Entry provides `ctx.acp`; external-Agent Entries are mounted below it and call
`ctx.acp.register(ctx, ...)`, explicitly preserving the consuming Entry identity across independently
bundled Plugin generations.
The service wraps every adapter as the generic executor contribution introduced by #5283, so it is
not a second backend or routing authority.

`@maka/antigravity-acp-plugin` now contains only executable/helper validation, Antigravity environment
policy, initial model configuration, and Antigravity question/failure recognition. The shared runtime owns:

- ACP initialize, Session creation, prompt, cancellation, and cleanup;
- one retained ACP process/Session per Maka conversation;
- ACP file callbacks with workspace and symlink containment;
- ACP tool/thought/text projection into generic executor events;
- ACP permission/question option identity and settlement;
- cancellation drain with the actual provider stop reason retained in the durable runtime ledger;
- bounded, cached model discovery and Agent-confirmed idle model changes;
- generic initial ACP configuration validation/application;
- Plugin-private external Session identity and write-ahead prompt state; a clean
  completed task can resume the same ACP Session after a Host/Plugin restart,
  while uncertain history stays readable without creating a replacement Session.

The Antigravity adapter owns:

- the official Antigravity executable and helper paths;
- the `ANTIGRAVITY_HARNESS_PATH`, proxy-bypass, and browser environment policy;
- the optional model value passed to the shared initial-configuration mechanism;
- recognition of official structured questions and provider error text.

The Host owns only executor visibility and binding, Maka Session/run identity, canonical event
persistence, hosted form admission, and Plugin retirement. No ACP process, credential, or external
Session identifier crosses the Plugin boundary.

## Restoring an existing task

After a restart, open the Antigravity task and choose **Restore** in the model
menu or the notice beside the composer. Maka starts the Agent only when you
choose to restore or continue. The Agent must support ACP `session/resume`; a
successful restore uses the original external Session and keeps the saved task
and model. No earlier prompt is sent again.

If restoration fails, the task history remains readable. Check the installed
Agent and helper, Google sign-in, and network access in **Settings → External
Agents**, then retry Restore. Maka will not create a new external Session for
that task. An executable or helper change also requires a new task because the
saved Session is bound to the previous installation.

**History gap** means a prompt may have reached the Agent before Maka finished
saving its terminal event. Maka inspects ACP load replay separately and does
not append possibly duplicate output to the saved history or resend that
prompt. Start a new task if you need to continue working. Tasks created before
this restoration version have no saved external Session ID and remain
history-only.

## Deliberately not ported

The rebuild does not carry forward the PR #5224 provider catalog protocol, external-Agent Session
protocol, renderer hot cache, draft/prewarm Session lease, ACP-specific backend registry branches,
custom storage fields, CLI transcript branches, model-picker forks, or visual-workaround changes.
Those components either duplicate #5283 or solve UI/configuration concerns that should be added as a
generic Plugin executor capability rather than an Antigravity branch.

The installation and authentication surface already merged in #5164 remains the producer of setup
facts. `HostBuiltinExternalAgentPluginCoordinator` projects the saved executable into system-managed
Plugin packages and a configured adapter Entry. The projection is content-addressed and idempotent:
it installs the ACP runtime before the adapter, replaces only a changed package layer, restores the
same state after Host restart, and removes the adapter before its runtime when the setting is cleared.
Adapter code never reads RuntimePolicy.

Both production `plugin.mjs` bundles are release dependencies of Runtime Host, so the same path is
available to Desktop-owned and managed/remote Hosts. The installed ACP service uses an isolated
Context label and an explicit consumer Context instead of relying on cross-bundle `Service`
`instanceof` identity.

## PR 2 producer-to-consumer delivery

| Checklist set | Producer → consumer | Status |
| --- | --- | --- |
| A: setup | RuntimePolicy executable facts → built-in Plugin packages/Entry → executor inspection | Implemented; unavailable/authentication states reach the model menu and setup navigation |
| B: selection | ACP provider discovery → generic catalog → Desktop model menu → atomic Session executor/config → first prompt | Implemented; bounded probe Sessions are temporary and never become Maka tasks |
| C: execution | Retained ACP Session → generic events/Hosted Forms → transcript → original option identity | Implemented; includes question forms, tools/diffs, file callbacks, follow-up, cancellation and cleanup |
| D: continuity | Plugin-owned durable continuity marker → process-free inspection → Session admission/Desktop readiness | Implemented; lost processes leave readable history and a new-task action, without replacement |

The existing Composer owns text and attachment drafts. One executor/model picker presents executors
in its left rail and the browsed executor's models in its main pane. Browsing never changes the draft;
choosing a model commits the executor and model together. The Maka pane embeds main's native model
component, so contributed executors and native models share one boundary without duplicating
selection state. Main's client model-selection extension slot remains intact. Existing tasks keep their executor; model changes require idle state,
confirmation from the Agent, and a successful Session configuration write. Unsupported attachments
and native operations produce validation instead of changing or discarding the user's input.
External task naming uses a message-derived title; native recap generation is unavailable and does
not call an unrelated model or drain the Host.

The generic contract consists of `ExecutorCatalogEntry`, `ExecutorConfiguration`, the
`plugin.executor.query` Host operation, and provider discovery/inspection/configuration methods.
Session storage persists `executorId`, generic configuration and the compatible main model field.
The Host canonicalizes `executorModel` and `executorConfig.model`, rejects contradictions and
unavailable models, and pins catalog-managed executor configuration even when the caller omits it. External ACP Session identity,
process handles, credentials, and continuity markers stay inside the Plugin.

The model-selection controller now lives in the existing Conversation feature so the Desktop
architecture ownership/budget checks remain satisfied. Root exports preserve existing consumers.
This does not introduce a new application architecture or another backend.

## Scope and acceptance

PR 2 covers local macOS arm64 Desktop and local Runtime Host. PR 3 added explicit restoration of the
same external Session after process loss, with a visible history gap when replay cannot be aligned.
PR 4 extends the generic executor configuration with opaque Agent modes. Draft catalogs now
belong to the configured executor instance and use a neutral directory for discovery, shared
across projects. A successful setup/login or configuration change invalidates provider discovery;
manual refresh requests a new neutral probe. Remote execution, OAuth forwarding, external child orchestration, steering and
cross-Agent continuation are not added here.

### Draft model catalog reuse

Successful discovery is cached in memory and persisted through the Host's namespaced Plugin
storage, without a time-based expiry. Opening a new draft after spending time in another task,
or after restarting the application or Host, reuses these candidates instead of starting
another ACP process. Standalone executors can opt into the same storage contract.

Snapshots are isolated by Host, Plugin scope, and executor entry. A versioned snapshot binds
to a digest of the configuration, launch arguments, platform, and executable/sidecar file
metadata. Configuration values and credentials are not stored in the snapshot. Missing,
incompatible, or corrupt snapshots fall back to discovery. Executable changes are detected
when loading a snapshot or saving a successful probe; inherited process environment changes do not invalidate it.
External account or upstream model changes reach the public catalog through manual refresh or
setup/login invalidation, rather than a timer or a background disposable Session.

Only neutral discovery populates the shared model catalog and its persisted snapshot. Real Session
initialization (including restoration), confirmed configuration changes, and `config_option_update`
notifications update that Session's capabilities, exposed by conversation inspection. Project-specific
models, selections, and modes never replace the public candidates. Every real Session still validates
requested configuration against its own advertised options. This boundary stays entirely inside the
ACP Plugin; Host queries and the UI continue to use the existing discovery/inspection contracts.
A task that starts before the first draft does not warm the public catalog. The first uncached draft
requires one neutral probe, then later drafts and restarts reuse it. Snapshot version 2 rejects older
snapshots because version 1 may contain project-specific candidates; an upgrade re-probes once.

First discovery without cached candidates and explicit refresh still use a disposable probe.
Transient refresh failures retain the successful in-memory and disk snapshot and expose a
refresh-failed notice. Cold discovery failures have a 60-second retry cooldown; this is not a
TTL for successful catalogs. Manual retry and explicit invalidation bypass the cooldown.
Authentication failures clear previous choices. Setup/login and configuration invalidation discard
the cache and fence pending disk reads and probes. Serialized writes prevent a pending save from
resurrecting an invalidated snapshot. Each successful neutral probe rechecks executable metadata and
persists its result, even when the model list is unchanged, so an in-place executable update does not
leave an obsolete snapshot binding. Cached reads do not touch storage. Normal shutdown drains pending
writes and retains the snapshot; storage failures leave the in-memory catalog usable.

Probes run serially within an executor. Cleanup retries finish before a replacement starts,
and shutdown waits for pending probe cleanup.

Setup/login invalidates only the affected executor. RuntimePolicy edits rely on Plugin
reconciliation to replace changed configurations; unrelated settings do not invalidate catalogs.
The draft picker first reads the process-free executor inventory, then discovers each executor
independently. Completed results and retry/loading state belong to each agent, so a slow
Antigravity probe does not block another agent's catalog or animate a selected native model.
The selected ready external agent exposes **Refresh models** beside the draft model picker.
The button is hidden while a native model is selected and remains outside the model list.
This refresh targets only the selected agent and preserves the draft selection. Inventory
transport failures retry the inventory rather than just the selected agent, clearing the error
through the full inventory recovery path. A successful single-agent read does not dismiss an
inventory error.
The executor query's inventory/filter fields require compatibility epoch 226.

See [PR 2 acceptance evidence](archive/antigravity-acp-pr2-acceptance.md),
[PR 3 acceptance evidence](archive/antigravity-acp-pr3-acceptance.md), and
[PR 4 acceptance evidence](archive/antigravity-acp-pr4-acceptance.md) for the checks and their limits.
