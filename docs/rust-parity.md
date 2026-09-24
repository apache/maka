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

# Rust parity and built-in plugins

[简体中文](rust-parity.zh-CN.md)

Baseline: Rust `c6874775d`, main `f02ac9433` (2026-09-18).
This records known functional gaps and the whole-domain built-in plugin migration plan, not a
complete acceptance audit. Target ownership and API extensions below are not claims of implementation.

Use our own business modules to develop the plugin API: migrate an existing domain and complete
its missing behavior together, then remove its special-purpose Host path. Registering a wrapper
around unchanged Host business logic does not complete a migration.

## Boundary

Execution semantics absorbed from main through `9082cf144`:

- Each logical request freezes its output cap against model capacity and matching usage. Compaction recovery uses at most 8,000 output tokens without rewriting model settings; physical retries keep the same cap.
- `ultra` is a public reasoning level. Account inventory or explicit model declarations enable it; native Responses sends it unchanged.
- WorkHub returns terminal results and pending-interaction notices through public execution commands. Notifications are bounded and mark omitted observations explicitly. Frozen plugin intents and Host receipts prevent duplicate returns after restart. Owned Stop/correction withdraw observation; resume restores it. `workhub_tasks inspect` pages full answers with an invocation-fenced cursor; questions and approvals stay in their original Session. Desktop tools are optional.
- Startup seals interrupted executions before serving exports. Copy/import preserve unknown effects and validate original dispatch evidence; neither rewrites tool arguments nor replays effects. Recovery and tool validation remain scoped to the selected invocation.

Business policy belongs in plugins; accepting work and preserving its facts belong in Host.
A feature needing durable data is not automatically a core feature: Graph and Scheduler already
own business state and recovery through built-in plugins.

- **Host:** canonical log, execution receipts, Session lineage, permissions, credential authority,
  metering, network policy, process/PTY ownership, shutdown and recovery of accepted operations.
- **Plugin:** workflow decisions, domain data/migrations, external protocol adapters, derived indexes,
  reports and business UI. It cannot rewrite Host facts or manufacture invocation authority.
- **Shared boundary:** plugins use narrow typed Host services. Each datum has one durable owner.
  Rust and JS use the same authorized capabilities. Domain stores may use their own migrations; no plugin receives arbitrary Host SQL access.

A built-in Rust plugin is statically linked code activated through the existing Fiber lifecycle,
not a new executable, thread, V8 or necessarily a new crate. Disabling withdraws new capability
admission and preserves business data. Host continues settling accepted work; the domain decides
how to reconcile it on reactivation. Plugin-dependent executors settle truthful interruptions.

Keep existing wire contracts where they serve current clients: a thin Host router can call a typed
plugin contribution, as Scheduler already does. New plugin business interfaces use Remote.
Do not maintain two implementations or grow the kernel's enum with business actions.
Client changes are allowed when they remove an obsolete path, as with Graph.

## Existing domain ownership

| Domain / current coupling | Target and completion condition |
| --- | --- |
| **Skills:** `maka.skills` owns discovery, input preparation, per-step tool/context snapshots, governance, preference CAS, preview, import and workspace/user publication. Published Client Contributions own Session/new-workspace pickers, management and draft suggestions. | Desktop supplies target-bound Slots, generic Remote transport and authorized native file actions. The old scanner, importer, controller and Skills IPC/preload facade are removed. Host retains thin external protocol adapters, admission and immutable receipts, not Skill resolution. |
| **WorkHub:** `maka.workhub` owns coordinator configuration, answer composition, native `workhub_tasks`, routing/selection/correction/Stop/Resume, steering/followup and recovery policy. Its Session behavior freezes tools and Direct/Code Mode consistently for initial and successor Turns. | The published Client owns the complete main/floating surface in `packages/workhub`, using Remote and origin-bound Session/attachment ports. Desktop owns native presentation, not orchestration. Host owns atomic managed Session creation, precise admission, canonical receipts and settlement. Client replacement reconciles pending submissions by their original identity; it never redispatches across Host epochs. |
| **Default assistant behavior:** `maka.assistant` publishes the default behavior, persona, personalization and workspace instructions. | Sources are frozen per logical model step; disabling the plugin removes its persona. Explicit Session/child instructions remain independent of replaceable prompt Contributions. Execution/compaction invariants remain Host-owned. |
| **Session checklist:** `maka.todo` owns `todo_read`/`todo_write`, typed documents and a live composer Client. | Public namespaced storage provides revision-checked replacement; Remote streams page complete snapshots for the caller's Session. Disable/restart preserves data. No Todo-specific Host service or Desktop IPC remains. |
| **Graph/Swarm:** built-in plugins; behavior selection uses an open typed identity. Graph uses public authorized Session/execution commands, scoped data and read-only preferences, without private Host handles. | Preserve existing orchestration and wakeup behavior. Reuse narrow commands where semantics match; typed domain repositories remain legitimate. |
| **Scheduler:** the plugin owns schedules, frozen triggers, misfire/retry policy and notification withdrawal. Activation receives public scoped storage, authorization, execution and notification capabilities, not scheduling-specific Host services. | Host resolves authorization and admits execution/native delivery. Pausing withdraws unadmitted notifications, including late provider acceptance; accepted executions remain Host-owned. Recovery reuses exact Fire identities and never replays uncertain notifications. Existing Desktop operations remain thin adapters to the plugin. |
| **Web:** `maka.web` owns browserless WebFetch, Tavily search, source selection, credential checks and the settings Client. Native search binds through the public provider-tool contract at each model step. | Host owns authorized HTTP, proxy policy, resource settlement and namespaced credentials. Rust and JS share bindings; provider results/citations remain canonical facts. The old Web RPC, global settings and Tavily vault slot are removed. |
| **Recall:** `maka.recall` owns Unicode literal matching, BM25 ranking, Session diversity and RecallMore passage expansion. | Public Rust/JS history supplies fixed-fence UTF-8 pages and archived metadata. Host owns access checks and the SQLx-managed text projection; no Recall-specific Host service or V8 is required. Incognito withdraws tools; unread sources and clipped passages are explicit. |
| **Code Mode:** mode selection, nested dispatch and history projection cross several crates. | After the first domain migrations, move its user-facing tool and mode policy where a real contribution boundary helps. Keep V8 ownership, nested-call permissions, dispatch/settlement and canonical history in the runtime. Do not invent a universal executor hook merely to move `exec`. |
| **Files and Shell tools:** registrations are assembled in Host over existing filesystem/process owners. | Tool definitions and assembly can become built-in contributions. Resource ownership, write coordination and PTY cancellation remain Host services. Defer this structural migration until it removes concrete coupling; a plugin per tool adds no value. |
| **Client Capability / MCP, providers and transport** | Keep their current resource/authority boundaries. Desktop-owned MCP does not move into Host, and model vendors do not each require a plugin. Complete their functional gaps independently of structural migrations. |

Any authorized plugin can request managed ownership with `createRoot({ managed: true, ... })`.
Host commits package/scope ownership and creation identity atomically. Ordinary mutations and other
plugins cannot bypass that ownership; replay never adopts an unrelated existing Session.

“Whole domain” means one business implementation and lifecycle, not moving every related type or
table. Host-stamped input receipts and execution facts are generic runtime contracts. Skill interpretation
and WorkHub delegation/correction links belong exclusively to their plugins.
Reuse SQLx migrations and domain stores; changing ownership does not require changing disk format,
moving all data into KV, or creating a crate per plugin. Runtime contracts must not depend on plugin
implementations; wire adapters may retain existing client vocabulary.

## Missing functionality and placement

“Plugin + Host” identifies separate responsibilities, not permission to defer either half.

| Domain | Remaining functionality | Target owner / necessary boundary |
| --- | --- | --- |
| Plan | State and durable receipts are complete: revision/abandonment, version and replan-source checks, frozen submissions, progress/interruption/resume/cancellation, exact retries and fixed-watermark history pages. Tools, Behavior, Remote/Desktop and live execution observation remain unwired. Non-Agent collaboration mode still fails admission. | **Plugin + Host.** The plugin owns workflow and records through public storage. Approving a plan grants no sandbox permissions; Host retains authorization and Turn admission. Without a Host receipt, execution is awaiting admission, not running. |
| Goal | Query/arm/control, continuation, termination, budget and recovery semantics. | **Plugin + Host.** Goal policy owns subsequent submissions; Host enforces admitted hard limits and records usage. Retiring the plugin must close future submission admission. |
| Session recap | `maka.session-recap` provides manual generation, durable idempotent receipts, Desktop Session Inspector and native Rust TUI access. The TUI checkpoints original operation identity before generation and explicitly retries that identity after reconnect. Automatic idle generation and the old `session.recap.generate` route remain absent. | **Plugin.** Uses authorized history and the Session model. Recaps are derived data and do not rewrite canonical history or Session metadata. |
| Daily review | Daily-review query/mutate and scheduled review remain. | **Plugin + Host.** Reuse Scheduler and authorized history/model services. |
| External agents | Setup start/query/cancel; execution adapters, configuration, auth, conversation identity, adapter-specific attachments/interactions/resume/fork. | **Plugin + Host.** Implement concrete CLI/ACP adapters as Executor plugins over owned processes/HTTP. Generic Executor support is not a shipped adapter. Host owns authorization, cancellation and canonical external-event recording. |
| Usage / Pricing | Physical Agent and auxiliary SDK accounting, frozen valuation, public Rust/JS scoped mixed model/tool activity paging, and shared native/plugin pricing query/CAS edits are implemented. Consistent summaries include complete bounded breakdowns and missing-data coverage; The Insights plugin provides settings reports, filtering, pagination, persisted views and rate editing; Session Inspector uses the public Session-bound Client slot. | **Plugin + Host.** Reports and rebuildable projections may be an Insights domain; Host records usage independently of plugin availability and provides consistent reads. Missing usage must not become zero. |
| Background health | BackgroundTaskHealth process and endpoint checks. | **Plugin + Host.** Health interpretation and Tool in a plugin; Host exposes authorized resource observations and bounded probes. A stored PID is not resource ownership. |
| Session lineage | Public Rust/JS history copying and source reads, native branch/revision create/abandon, independent inherited pruning, Desktop canonical-input editing and complete durable drafts are implemented. Regeneration is removed; edits use revision and resend. | **Host.** One transactional lineage and workspace authority; plugins request changes through commands, not private lineage storage. |
| Session lifecycle | Native and public plugin removal/preview/receipt APIs, atomic family retirement and queued cancellation, restart cleanup and shared-worktree ownership are implemented. Unreferenced conversation bodies, tool payloads and request surfaces are reclaimed in restartable batches while accounting, receipts and referenced history survive. Shared Session queries remain. | **Host.** Preserve referenced history and accepted receipts; unknown process cleanup must not delete its workspace. Shared queries require real collaboration authorization. |
| Session transfer | Public Rust/JS historical import supports bounded staging, exact retries, current-ceiling checks and atomic publication. The built-in plugin owns Codex, Claude Code and OpenCode conversion, catalogs, source configuration and durable intents. Its Desktop settings page and standalone Remote share destination reauthorization and receipt recovery. Native bundles preserve original history/proofs, archived output, attachments and accounting through bounded compression and atomic import receipts. Desktop uses Host inventory confirmation and an explicitly chosen destination workspace; source permissions, plugin ownership and pending work are not restored. Dedicated TUI import UI remains. | **Plugin + Host.** Adapters own discovery and parsing; Host owns canonical material, identities and publication. Imported conversation participates in history, branching and compaction without claiming local execution or usage. Native bundle format remains a Host contract. |
| Runtime policy | Shell/external-agent consumers and ordinary named tool profiles. | **Split.** Shell launch policy and capability ceilings stay in Host. External-agent settings belong to their domain. Profiles contribute definitions; Host applies the intersection at admission and per-step capture. Storing settings alone is insufficient. |
| Access / collaboration | Credential rotation prepare/revoke; principal revoke; collaboration access, invitation, grant revoke, principal rename/revoke; Turn-request create/query/decide/acknowledge/withdraw. | **Host.** Reuse credential and durable admission authority. Plugins may provide workflows/UI but cannot decide grants, bypass revocation or own canonical accepted Turn requests. |
| Peer Mesh | Create/query/invite/join/leave/remove/close/reconcile, rename/display-name and transit control. | **Host for this rewrite.** Identity, routing and transport recovery must work during plugin recovery/unavailability. Do not add a transport-plugin platform to complete these protocols. |
| Credential export | `configuration.credentials.export`. | **Host.** Explicitly authorized export from the real vault; plugin-scoped credentials are not blanket vault access. |
| Model providers | Google/Cohere; remaining declared auth, reasoning/usage/options behavior; runtime models.dev refresh; Copilot/xAI inference and credential-backed verification. | **Model/Host layer initially.** Keep shared transport, streaming, retries, metering and request snapshots. Metadata-source policies can later be contributions; no one-plugin-per-vendor mandate. Command Code CLI execution belongs with Executors above. |
| Diagnostics / hosted runs | `execution.inspect.query`, `host.resources.query`, `hosted.execution.start/cancel`. | **Host**, with optional plugin presentation/orchestration. Inspection reads canonical evidence; hosted execution must preserve environment, ownership and cancellation. It is not merely another Executor name. |

## Consumer-driven API work

The kernel exists, but the current SDK is not a universal implementation surface.
Original TS plugins are not source-compatible with the new SDK.

| Consumer / needed capability | Current evidence / smallest useful extension |
| --- | --- |
| Input preparation | Native typed Contributions and JS `ctx.input.prepare` share ordered preparation, stamped receipts and retirement checks. Native revisions provide nonblocking admission/invalidation ordering. Queue edits and steering prepare before admission; accepted promotion/replay never rescan sources. |
| Skills: tool publication | Skill/SkillSearch are ordinary Contributions, without a package-name privilege. Per-step bindings capture handlers and supporting context together, after tool ceilings; physical retries retain the same snapshot. |
| WorkHub: precise execution commands | Typed commands carry stable operation IDs, exact targets and expected revisions. Correction freezes plugin intent before exact Host control/submission and atomically commits its business receipt; accepted work settles independently of plugin availability. Queue editing preserves the original submission proof. Plugins receive neither SQL transaction callbacks nor unrestricted execution handles. |
| WorkHub / Graph / Plan: selectable behavior | Open `BehaviorId` selects a typed Contribution; Graph/Swarm register independently. Host acceptance covers a non-builtin business. Preserve Session defaults and durable per-Turn choices; a requested unavailable behavior fails explicitly. Behavior preparation and input preparation are separate contracts, not one hook bus. |
| Skills / Web / Recall / Insights: authorized services | Public history provides fixed-fence text paging and archived Session metadata to Rust and JS. Admitted Agent calls may read the trusted profile; Remote/background callers retain scoped history authorization. Public Usage reads expose scoped model/tool attempts and refusals without conversation bodies. Fixed-fence summaries and bounded breakdowns are available; Insights consumes them through public Remote and Client APIs; Session Inspector uses the public Session-bound Client slot. Domain catalog/mutation APIs can be typed plugin Services rather than new kernel methods. |
| Skills / WorkHub / default behavior: business UI and prompt context | Published Clients own the actual Skills picker/management and WorkHub surface through Slots and Remote. Native adapters validate the originating Host and document; connection replacement revokes old Remote leases without replay. Prompt Contributions own business instructions. Inactive features remain visibly unavailable without blocking ordinary chat. |
| Other TS extension services | New SDK lacks equivalent public registrations/services for LSP routing, commands, Skills/Goals queries, shell environment contributions, Settings definitions, authorization flows and LLM adapter registration; questions/forms and source-input/attachment-copy contracts are public; permission approvals remain Host-owned. Implement domain registries as plugin services where possible, retaining Host authority for sensitive actions. `llm.generate` is not adapter registration. |

These are functional extension points to assess and implement, not a promise to copy every TS method.
TS LLM adapter registration serves plugin model calls; it does not itself register a main Session transport.
Do not prebuild a generic provider framework, event bus or universal repository for them.

Built-in Rust uses typed calls directly, not a JSON/V8 round trip. Rust and JS adapters share
capability semantics, authorization and retirement guarantees; public JS bindings are added for
new cross-language capability contracts with a real consumer. A Rust-only domain repository need
not become a JS API. Do not postpone necessary API work by granting a built-in unrestricted Host access.

Pending submissions belong to the Desktop document, scoped to the originating Host and Session;
resolver withdrawal and Client replacement preserve their exact inputs and Stop intent.
Corrections persist frozen business intents before Host commands. Recovery observes exact receipts;
it does not reinterpret uncertain work using current policy or defaults.

## Delivery order

1. **Public API consumers — migrated:** Skills, default assistant, Scheduler, Graph and WorkHub use
   the same scoped contracts as external plugins. Maintain Rust/JS parity as new consumers appear.
2. **External acceptance:** the JS workflow fixture exercises UI consent, durable background work,
   exact receipts, disable/reactivation and revocation across Host restart.
3. **Missing business domains:** complete Plan/Goal and review;
   finish external adapters and Insights/health. Reuse the domain boundaries rather than first
   implementing new business logic in Host and moving it later.
4. **Remaining core parity:** complete Session lifecycle/lineage/transfer, policy, access/collaboration,
   Peer Mesh, providers and diagnostics. Pull required core commands into their consumer's earlier
   stage; core work is not blocked on all plugins or a marketplace. Assess Code Mode/tool assembly
   migration after the first domains establish a useful boundary, not as a prerequisite to parity.

Within each domain: identify a real consumer and invariant → implement the smallest typed API and
consumer together → verify lifecycle and failure behavior → remove the old Host business path.
Use a second existing consumer where it actually shares the contract; do not invent a mock business
to justify an abstraction. Update the SDK contract in the same slice when it changes. If a proposed
API needs arbitrary Host access, a second authority or many business exceptions, revise the boundary.

Every domain must cover its mutation/query surface, error distinctions, authorization, cancellation,
lost replies, restart recovery and actual Desktop consumers before being marked complete.
Use a few end-to-end acceptance cases including retirement and reactivation; a registered Tool or
passing schema test is not acceptance.

The first migrations must also prove:

- Skills-disabled ordinary chat works; a new explicit Skill request fails clearly. Accepted content
  and receipts survive edits, updates, retirement and restart without rescanning Skills; pending
  promotion still enforces current permissions. Preparation racing retirement cannot admit stale work.
- Skill publication detects local edits, handles commit uncertainty and recovers complete bytes,
  lock and baseline together. Discovery, tools and UI observe the same domain revisions.
- WorkHub lost replies and restart during correction neither duplicate delivery nor target newer
  unrelated work. Disabling stops new orchestration while Host settles accepted operations; re-enable
  reconciles their receipts before continuing.
- Real Desktop consumers use the published plugin route with stale-call rejection. Source review
  confirms Host no longer scans Skills, chooses WorkHub policy or supplies a duplicate default persona.

Move or extend existing high-value tests instead of keeping duplicate old/new suites. Retain the
existing cross-platform permission, filesystem and PTY coverage; migration is not a reason to weaken it.

## Already present and excluded

WorkHub; ordinary resume; core files/shell/PTY; Client Capability including Desktop-owned MCP;
model streaming, compaction and dynamic tool loading; the plugin kernel, Rust/JS loading,
shared/dedicated plugin V8s, scoped storage/credentials/files/HTTP/process/PTY/model/client calls,
Executors and Client Remote; Graph/Swarm and Scheduler are implemented.
Old `agent.graph.*` RPCs were replaced by the plugin route, not left as a second Graph implementation.

Memory and redaction are excluded; OS sandboxing is deferred. Copilot/xAI live adaptation is deferred
until suitable credentials. Packaging/deployment is not full product parity: native CLI operators do
not replace the TS interactive CLI/ACP surface or migrate legacy TS state roots automatically.
Those product/data migration decisions must not be hidden inside a plugin.
The TS client/TUI need not be rewritten in Rust; its native-Host compatibility still needs acceptance.
Legacy state-root migration is a separate scope decision, not implicitly authorized by parity work.

## Evidence

- [Host registry](../crates/runtime-host/src/server/operations.rs), [dispatch](../crates/runtime-host/src/server/dispatch.rs), [operation vocabulary](../crates/protocol/src/operation.rs).
- [Execution preparation](../crates/runtime-host/src/execution/prepare/environment.rs), [tool assembly](../crates/runtime-host/src/execution/tools.rs), [policy consumers](../crates/runtime-host/src/server/configuration/policy.rs), [provider routing](../crates/runtime-host/src/provider_route.rs).
- [Skills domain](../crates/skills/src/lib.rs), [input preparation](../crates/runtime-host/src/execution/input/prepared.rs), [WorkHub workflow](../crates/workhub/src/control.rs), [Host commands](../crates/runtime-host/src/execution/plugins.rs), [business transactions](../crates/workhub/src/repository.rs), [default prompt](../crates/assistant/src/prompt.rs), [Graph wiring](../crates/runtime-host/src/plugins/graph.rs).
- [SDK contracts](../packages/plugin-sdk/README.md), [execution services](../crates/plugins/src/execution.rs), [Session behavior](../crates/plugins/src/session.rs), [Scheduler router](../crates/runtime-host/src/server/scheduler.rs).
- TS [composition](../packages/runtime-host/src/server/execution-composition.ts), [interactive tools](../packages/runtime-host/src/server/interactive-run-composer.ts), [inspection](../packages/runtime-host/src/server/execution-inspect-coordinator.ts), [external imports](architecture/external-session-import-design.md).
