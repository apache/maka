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

## Why PR #5224 cannot be carried forward unchanged

PR #5224 predates the Plugin-backed Session executor architecture from #5283. It adds a dedicated
ACP backend and then threads external-Agent identity, model catalogs, session control, protocol
operations, Desktop bridges, and Composer state through the Host. The branch changes 139 files and
adds roughly 7,800 lines relative to its current merge base.

The new architecture already owns those cross-cutting responsibilities generically:

| Concern | PR #5224 implementation | Current `main` authority |
| --- | --- | --- |
| Session routing | `AcpAgentBackend` registered in Host execution composition | `executorId` plus `PluginExecutorBackend` |
| Executor lifetime | ACP-specific Host residency and backend registry logic | Plugin Entry generation, retirement, and executor binding |
| Transcript | ACP event conversion plus new external-session fields | Generic executor events enter the canonical Session stream |
| Process and credentials | Runtime Host ACP module | Contributing Plugin; opaque to Maka Runtime |
| Child/Graph execution | ACP-specific guards | Generic executor propagation from #5283 |
| Model choice | Provider catalog protocol and ACP-specific Desktop state | Plugin configuration for this rebuild; a generic executor-configuration capability can follow |
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
policy, and optional initial model configuration. The shared runtime owns:

- ACP initialize, Session creation, prompt, cancellation, and cleanup;
- one retained ACP process/Session per Maka conversation;
- ACP file callbacks with workspace and symlink containment;
- ACP tool/thought/text projection into generic executor events;
- ACP permission option identity and settlement;
- generic initial ACP configuration validation/application;
- durable history-only detection so a Host/Plugin restart cannot silently fork an existing external
  conversation into a new ACP Session.

The Antigravity adapter owns:

- the official Antigravity executable and helper paths;
- the `ANTIGRAVITY_HARNESS_PATH`, proxy-bypass, and browser environment policy;
- the optional model value passed to the shared initial-configuration mechanism.

The Host owns only executor visibility and binding, Maka Session/run identity, canonical event
persistence, hosted form admission, and Plugin retirement. No ACP process, credential, or external
Session identifier crosses the Plugin boundary.

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

## Remaining PR 2 work

PR 2 remains one pull request, organized as four reviewable producer-to-consumer sets:

1. Setup facts to active executor: implemented by the system-managed package projection above;
   readiness projection still needs the bounded provider probe used by Desktop.
2. Provider catalog to Desktop choice to first prompt: add a generic executor catalog/configuration
   contract and integrate it into the existing model menu without creating preview Sessions.
3. ACP updates/interactions to canonical conversation settlement: add generic Agent questions and
   complete race, unsupported-input, and rendering coverage.
4. Process continuity facts to task readiness: project history-only/process-loss into generic Session
   and Desktop readiness and finish controlled official-provider acceptance.
