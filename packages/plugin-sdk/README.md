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

# Maka plugin SDK

[简体中文](README.zh-CN.md)

TypeScript contracts for trusted Rust-Host plugins. Host SDK API **1** is independent of Maka's application version. This workspace is not yet published.

```ts
import type { HostPlugin } from '@maka-agent/plugin-sdk/host';

const activate: HostPlugin = async (ctx) => {
  await ctx.tools.register<{ text: string }>(
    {
      name: 'Echo',
      description: 'Return the supplied text.',
      inputSchema: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
        additionalProperties: false,
      },
    },
    ({ text }) => ({ text }),
  );
};
export default activate;
```

`ctx.behaviors.register(name, prepare, { nativeInput: 'native_user_messages' })` explicitly allows canonical user messages in model Sessions managed by that same package and scope. The default is `denied`. The Host checks the live behavior registration and current caller authority before admission; retirement or replacement invalidates an in-flight preparation. This policy preserves native message IDs, attachments, selections, queue placement and receipts, and does not enable manager-only configuration, revision or resume operations. Managed native messages cannot override orchestration mode.

Bundle one ESM entrypoint without imports or top-level await. Set `runtime: { entry: "index.mjs", sdkVersion: 1, vm: "shared" }` in `maka.extension.json`; `dedicated` requests a separate VM for that package generation.

Prompt providers receive a tagged Session or model-step context, never fabricated tool authority. Sections and dynamic context default to templates; use `format: 'plain'` for resolved or user-authored text. A `complete` section replaces other prompt Contributions, not explicit Session/child instructions. Physical retries reuse the same frozen composition.

`ctx.background.pending(name, wake)` prevents idle expiry while plugin-owned work remains. Close the registration when idle; recover durable intent and register again after activation. It grants no authority and does not prevent explicit shutdown or upgrades. System-resume wake callbacks are serial and coalesced; they receive cancellation and may close their own registration. Rust plugins publish the same `BackgroundWork` contribution with a synchronous pending projection. `ctx.run` alone does not keep the Host resident.

Prompt callbacks receive `call.workspace`; input preparation receives `request.workspace`. These bounded read-only directory views expire when the callback finishes. They cannot write, execute commands, traverse outside the workspace or be retained for background work. `ctx.inputs.names()` lists explicitly mounted non-secret inputs; `ctx.inputs.at(name)` provides the same read/list interface, limited to selected files or subtrees and the plugin's lifetime. Confined symlinks are allowed unless `symlinks: 'reject'` is specified; mounted selections also constrain their targets.

`view.openFile({ path })` pins a regular file and its observed length. `info` contains length and modification time; `read({ offset, limit })` reads at most 1 MiB and excludes subsequent appends. Path replacement cannot redirect the handle, but in-place changes remain observable; format consumers validate digests between passes. Truncation inside the pinned prefix fails explicitly. Rust `PinnedFile::with_reader` batches the same bounded reads on a blocking worker. Each batch rechecks authorization; callback completion or Fiber retirement closes the file. `close()` acknowledges release. At most 32 files may remain open per admitted root.

`call.files.entries` and `ctx.data` share bounded byte/directory primitives: read, write, list, stat, createDirectory, sync, remove and no-clobber rename. Paths are relative, links are rejected and parents must exist. Writes accept `createNew` and ordinary permission bits. Read/list workers observe retirement; already admitted writes finish settlement. Transactions and crash recovery belong to the plugin. `{ kind: 'directory', path }` consent grants only file access without creating a workspace marker; replacing that directory invalidates the grant. `withAuthorization(id, (call, grant, boundary) => ...)` supplies the current grant and Host-resolved boundary observations; path aliases in the original proposal need not equal the resolved path. Read views expose `location()` for display or consent proposals, never as authority.

`call.clients.notify` requires explicit notification consent and targets the consenting Client. Cancellation withdraws an unadmitted offer; an admitted delivery still settles. Delivery uncertainty is never automatically retried.

Explicit `network` consent authorizes Host HTTP independently of the file/process sandbox; a read-only workspace can use HTTP without gaining file writes or process access. Agent HTTP still requires its own execution authority. Restoring consent after restart rechecks the current grant; revocation blocks new requests.

Each Agent tool or Executor call captures the current permission boundary. A Session permission change applies to new calls, not existing scopes or processes. Service forwarding retains the original boundary; stale scopes cannot start new effects, while already accepted work still settles.

A settled but uncertain effect is recorded as `unknown` and returned explicitly. It does not block subsequent recovery calls. Missing durable facts or unconfirmed resource cleanup close admission instead; catching an SDK error cannot hide them.

Remote Session/workspace views include `files` with the same interface. Reads recheck current credentials and workspace binding, belong to the Remote call's resource settlement, and expire with that callback. A serialized workspace path is only observation, not authority.

`caller.views.queryDatabase({ path, queries })` reads an explicit trusted Host SQLite path through a `host_paths` Remote endpoint. The batch shares one read transaction, honors WAL and closes before settling. Host state is excluded; current credentials and Session scope still apply. This is not a captured-directory guarantee against malicious same-user path replacement. Results preserve integers as decimal strings and blobs as base64. Queries allow read-oriented builtins and schema inspection, not mutation or extensions; limits are 16 statements, 250,000 rows and 64 MiB encoded output, with cooperative work/deadline checks rather than OS isolation.

`ctx.tools.bind(definitions, capture)` freezes one implementation and optional context for a tool group at each logical model step. The capture callback receives a read-only workspace view; returning `null` omits the group. Returned calls use the frozen closure, not a recaptured implementation. Closing the registration withdraws the whole group. `alwaysVisible` advertises a tool without a prior search.

Capture receives non-secret `model` facts: the selected ID, effective capabilities and supported provider-tool protocol. A binding may return `providerTools: { Research: { id: 'openai.web_search', args: {} } }` for its own registered names. These tools execute inside the primary model request, not through a local handler; a provider-only binding omits `invoke`. Descriptors, local closures and supporting context freeze together through physical retries. Provider tools cannot settle a Host turn or run inside Code Mode.

The installed SDK must recognize the descriptor as provider-executed. Unknown IDs and provider-defined local tools are rejected before network I/O, never silently omitted.

- Activation stages registrations. Start business loops with `ctx.run`, after publication. Register cleanup with `ctx.effect`; observe `ctx.signal`.
- `ctx.input.prepare(name, callback)` prepares text before admission, returning unchanged, ready with a receipt, or blocked. It has no invocation authority and cannot replace attachments or prior receipts. Host stamps provenance and preserves accepted input across replay. Keep callbacks pure; close/re-register when mutable sources change so stale preparations cannot be admitted.
- Tool and executor callbacks receive invocation-bound services and processes. Old call handles expire; instance processes must be reopened through the next call's `processes.open(id)`. Unloading owns their cleanup.
- Process spawn uses the source's frozen workspace, sandbox and approved additions, with an absolute executable plus argv. Unsupported isolation fails before launch. The default lifetime is the calling scope; rebinding an instance process or PTY requires current permissions to cover its original sandbox. Strings written to stdin are UTF-8; decode output incrementally with `TextDecoder`.
- `call.terminals` uses the same command and lifetime contract with native PTYs, serialized input/resize receipts, bounded output with explicit reset events, and durable exit/cleanup. Instance terminals must be reopened by later calls; retirement closes them. Host parses terminals natively with Alacritty.
- `call.permissions.request({ reason, permissions })` requests additional file/network access for an Agent tool or Executor. Host resolves paths before approval; protected resources remain inaccessible. The returned approved subset is not a capability token: each effect rechecks current authority. Executors have no tool-call identity and can only receive Turn/Session grants. Independent Remote/background work uses explicit authorization instead.
- `call.http.request` uses Host proxy settings and requests missing network approval without disabling the file sandbox. Independent calls require explicit `network` consent. Read bounded byte chunks with `response.next()`; `null` means complete, whereas truncation fails. Responses close with the calling scope or retirement. No automatic retries or redirects: remote side-effect recovery belongs to the plugin.
  Host records admission before sending and settlement before EOF: Agent calls use their invocation journal; independent calls use Host effect records. Interrupted transfers retain an unknown outcome, not a replayable failure. Records contain request metadata and body digest, not a second copy of streamed payloads.
- Behavior preparation receives a bounded Session configuration snapshot, not authority. Acquired execution handles expose `activity(sessionId)` and `stop(invocation)`; persist the observed identity before control, never reselect a target on retry. `artifact({ operationId, artifactId, offset, limit })` reads at most 64 KiB from that execution's Turn.
- `resume({ operationId, source })` resumes one exact sealed model Run. Retries return the same canonical opening, including after Host restart; source selection remains plugin business logic. Preparation runs outside Host admission locks.
- `configure({ sessionId, expectedRevision, target })` changes an idle Session’s model/Executor with CAS, never its permission, workspace or behavior. `createRoot({ managed: true, ... })` gives the package exclusive management, not additional resource permissions. `plugin_workspace` consent selects a private workspace separate from the package’s data directory.
- Executor targets accept `settings: { model?, thinkingLevel? }`; omission selects the executor's defaults, not a Host model connection. The complete settings object replaces the previous selection. Executor callbacks receive it as `request.settings`, committed with the exact executor identity before dispatch; reconfiguration only affects later executions.
- `ctx.executors.search({ query? })` discovers registered executors in the plugin's scope, returning IDs, display names and declared capabilities. Pages are bounded to 50 entries / 48 KiB; `complete: false` requires a narrower query. Discovery grants no execution authority; retirement removes an executor from subsequent queries.
- `submit` freezes input preparation before accepting work. Blocked input creates no receipt; accepted content and its stable receipt commit together. Remote submission uses the authenticated Client connection, never a plugin-supplied connection ID.
- `enqueue({ operationId, messageId, invocation, content, placement })` queues against an exact live Run. Stable receipts survive plugin replacement and Host restart. `message(operationId)` reports pending, cancelled or delivered input and whether delivery exclusively owns a Turn; `retract(operationId)` never stops delivered/shared work.
- `offerInteraction({ operationId, invocation, prompt })` publishes a package-owned question/form. Host stamps requester identity; `waitInteraction` cancellation does not withdraw it, and `closeInteraction` cannot replace a committed answer. Permission approvals are not supported through this API.
- `call.sessions.list({ revision?, cursor?, includeArchived? })` returns bounded metadata pages. Agent calls see their own Session; independent calls require `read_sessions` for the selected scope. Catalog access never grants execution authority.
- `call.history.list` uses the same catalog format, including archive status and last-message time. Admitted Agent calls can read the trusted Host profile across Sessions; Remote/background calls require scoped `read_history` authorization. `read({ sessionId, through?, cursor? })` returns preparation progress or UTF-8 text chunks under a fixed log fence. Reuse the returned fence and cursor until `next` is null. Each read checks current access and source existence; it grants no execution authority. Ranking and passage assembly belong to the consuming plugin.
- Session-scoped execution commands use stable operation IDs: equal retries return the original receipt; changed content conflicts. Profile entries receive no implicit Session authority.
- `readMessage({ sessionId, messageId, cursor? })` observes exact delivery lineage, terminal answer excerpts and pending interaction IDs/types in one snapshot. Follow `answer.next` for UTF-8 pages (at most 16 KiB); its invocation fence rejects a changed execution. Interaction notices grant no authority to answer or approve.
- `executions.importSession` stages historical records under a root-creation grant. Persist the operation ID, append at the returned record position, then publish the exact total; identical retries recover the receipt. Staging is hidden from the Session catalog. Publication rechecks current permission ceilings and requires user or assistant conversation. Limits are 7,500 records and 6 MiB of canonical material, at most eight records per batch; excess input fails without publishing a partial conversation. Imported tools are observations, never executable calls or usage. `inspect` recovers progress; `abandon` discards an unpublished import, never an already published Session.
- Import `tool_call` and `tool_result` records separately in source order. Normalize `callId` within the source Session and use the same key for its result; no result is synthesized for an unfinished call.
- `call.history.sources({ sessionId, turnId })` reads ordered original inputs before preparation, including accepted queue edits and owned attachments. It returns at most 64 messages / 64 KiB of text, without silent truncation. These are not aggregate transcript rows or admission proofs; resubmission needs fresh identities and current preparation.
- `call.history.copySession(target, { source, root })` creates an owned history copy using an independent root-creation capability. The destination must use the same workspace; copying a managed source requires its package/scope owner. Persist the operation ID and source revision for exact retries; `target.restoreRoot` recovers an accepted destination without replaying creation. Inherited history does not grant source execution authority.
- `target.abandonRevision(operationId)` removes only an unused owned revision. Accepted work retains the Session; retries return the durable decision, including after restart. Removing a draft closes its subscriptions, not their connections.
- `executions.submit({ orchestrationMode })` selects a mode for that execution without changing the Session default. `query()` exposes `attentionId` for the current blocking interaction set or handoff, stable across unrelated log writes.
- `call.clients.tools()` lists only the authorized source's frozen Client Capability tools; `call.clients.call({ name, input })` uses Host permissions, approval/forms, cancellation and durable settlement. Model and Executor invocations share this boundary. Later publication or permission widening does not expand it.
- Storage is package/scope namespaced with CAS revisions and atomic batches. Tombstones retain revisions. Business migrations belong to the plugin.
- `ctx.preferences.read()` returns revisioned personalization, privacy, tool mode and the workspace-instructions setting, never credentials or full Host configuration. It is available during activation and expires with the plugin; it grants no resource or execution authority.
- `call.llm.generate` uses the authorized source's model binding and Host proxy/OAuth, sharing the main model executor. It sends only its explicit prompt/system, with no tools or inherited conversation. Defaults to 2048 output tokens; input is limited to 256 KiB and the response stream to 2 MiB. Results and reported usage settle durably before delivery; missing usage remains unknown. Abandoned calls are cancelled and drained with their calling scope.
- `ctx.credentials` stores package/scope-isolated secrets in the Host's private credential database, not ordinary storage or execution history. Writes compare revisions; deletion retains a tombstone. Limits: 64 KiB per value, 256 stable keys per namespace. Protection follows the existing vault's file permissions/ACL, not an additional encryption layer.
- `call.files` provides typed read/write/edit/glob/grep/patch operations through Host tools and durable settlement. Permissions cannot exceed the admitted or current Session boundary or tool ceiling. Reads return bounded pages or persisted image references; search results report completeness. File effects remain owned even if their Promise is abandoned. Service forwarding preserves this settlement obligation.
- Only encoding and URL globals are installed. Files, network, timers, and processes are not ambient Node APIs; use Host SDK services. No hostile-code isolation is promised.

`npm --workspace @maka-agent/plugin-sdk run typecheck` also checks the actual plugin fixture exercised by Rust Host integration tests.

`commands.createChild({ ..., workspace: 'isolated_git' })` binds a Host-owned linked worktree to the child Session. The parent must permit writes and have a clean repository-root workspace. Replays and Host restarts preserve child changes. After execution and workspace writers settle, `workspacePatch(operationId)` publishes an immutable, base-relative Git patch artifact, including committed and uncommitted changes; it never merges into the parent. Export before advancing the child to another Turn. Workspaces remain available for resumption; disabling a plugin does not delete them. Sparse checkout, submodules, external Git filters, and patches exceeding 50 MiB fail explicitly. Host Git operations use gix, not a system Git executable.

## Client SDK

When provided, `settings.page.onOpenSession(rawSessionId)` projects the ID through the originating Host and rejects navigation after page, Host or connection retirement.

`ctx.slots.register('tool.detail', toolName, Component, { order? })` replaces the detail body for an exact tool name. The first registration in slot order wins. Props identify the canonical Session, Turn and tool call and carry observed arguments, result and bounded output; open payloads require narrowing. Native sandbox/recovery controls remain outside the extension. Missing, retired or failed renderers fall back to native details.

`ctx.slots.register('settings.page', key, Component, { label, order? })` publishes a page and its navigation entry together on the selected Settings Host. `label` is a string or an `en`/`zh-CN`/`zh-TW` translation map; the component receives `locale` and `page` (the registration key). Selection expires on Host, connection or registration replacement. Native settings remain available while plugins reconnect. Other slots accept optional `{ order }`.

Client SDK API **1** uses React supplied by Desktop. Export a `ClientPlugin` from `@maka-agent/plugin-sdk/client`; its `activate(ctx, config)` stages keyed Slot registrations and effects. Slot registration closes after initialization. `ctx.effect` and `ctx.style` remain available while active; their disposer is idempotent. Async cleanup stays owned until settlement, including after explicit disposal. Cleanup failure requires reloading the document before that Entry can activate again.

Build with `buildClient({ packageId, entryPoint })` from `@maka-agent/plugin-sdk/build` (requires esbuild in the author's build environment). Save the returned JavaScript and declare `client: { entry: "client.js", sdkVersion: 1 }` in the manifest. The loader checks exact bytes and SDK compatibility before execution. Bundles share the trusted Renderer, not a sandbox; they have no Node compatibility layer.

Slots include `session.composer.before`, `workspace.composer.before`, `workspace.manage`, `application.manage` and `navigation.status`. Application actions carry an ID and an explicit `handled()` acknowledgement. Workspace props describe a candidate, not an authorized filesystem path. Composer Slots offer draft-only `appendText` and `publishSuggestions`. A publication has `update(items)` and `dispose()`; update the same owner on refresh and dispose it on effect cleanup. Item identities survive refresh; publications retire with their owner or target and never submit a message. Each registration has an Entry-local key and optional numeric order. Declare package imports in manifest dependencies; React, `react/jsx-runtime`, and the Client SDK are supplied by Desktop. Do not bundle another React instance.

Suggestions may set `tokenLabel` to display `insertText` as an inline chip. The label is presentation only; submission, editing and recovery still use the serialized text.

Optional `ctx.localFiles.pick()` / `open(path)` use Desktop-local paths only. They are unavailable for remote Host files. Desktop validates the published Client identity before native actions and discards picker results after navigation or retirement.

`application.overlay` mounts on the application's default Host. `session.header.actions` and `turn.footer` mount on the viewed Session's Host with canonical `sessionId`; the footer also receives `turnId`, once per visible Turn even after steering. They add UI without replacing native actions. Session and Turn props identify observations, not execution permission.

`ctx.events.subscribe({ kind: 'session.changed' }, listener, onError?)` observes originating-Host invalidations. `session.event` and `tool.activity` also require `sessionId`, always canonical on that Host. The listener receives a discriminated `ClientProductEvent`; event-specific payloads remain open product projections. These observations include live deltas and replayed seeds, not durable `LogEvent`s or exactly-once receipts. Subscriptions publish with the instance and stop immediately on disposal or retirement; they never follow a replacement connection. Plugin-owned domain changes use public Remote streams.

Desktop supplies `@maka/ui/plugin` as a shared UI module (currently `Button`). Import supported components from this entry instead of bundling another component-library instance. It is not the internal UI package's complete API.

Host plugins publish `ctx.remote.method(name, callback)` or `ctx.remote.stream(name, open)`. Client plugins obtain a callable with `ctx.remote.method<Input, Output>(name, sessionId?)` or an async-iterable factory with `ctx.remote.stream<Input, Output>(name, sessionId?)`. Calls start only after UI publication. Handles retain their original Host connection and backend registration; replacement never redirects them. Breaking iteration closes its stream; retiring UI or navigating closes its document. Remote callers are not Agent invocations and receive no implicit process permission.

Remote callbacks may throw an `Error` carrying a `RemoteFailure.code`. `outcome_unknown` preserves an uncertain business result and requires domain recovery, not blind retry. It does not fence an otherwise settled plugin; Host independently fences unconfirmed resource cleanup. Unclassified exceptions become `operation_unavailable`.

Streams allow one outstanding pull. Returning or cancelling interrupts a pending pull without waiting for the producer; late opens are cleaned up and late items are discarded. This ends observation, not Host-owned settlement of accepted work.

Authenticated applications can also bind `plugin.remote` by `{ packageId, method, sessionId }`, without loading a plugin UI. Rust providers without a frontend use `Endpoint::standalone`; JS providers use the same `ctx.remote` registrations. Package bindings pin the backend registration and retain document ownership, cancellation and authorization. They do not acquire a frontend identity or bypass Host grants. Paired client bindings additionally verify package bytes and retire with the UI.

Native endpoints accepting caller-supplied Host paths declare `Endpoint::requiring_host_paths()`. Host checks that grant at both bind and call, even for a borrowed registration target. Project-ID and existing-Session queries do not require raw-path authority; plugins receive explicitly injected read-only views.

`ctx.models.search({ query })` returns enabled chat choices with supported and default thinking levels, at most 50 entries / 48 KiB; refine the query when `complete` is false. `ctx.models.resolve({ kind: 'named', connectionSlug, model })` returns the same choice shape for an exact model; `{ kind: 'default' }` resolves the current default. Neither grants execution authority or promises provider readiness.

`restoreRoot(operationId)` recovers a root created by this package/scope under current workspace and source ceilings, independently of its original model. Creation provenance does not make an ordinary root exclusively managed. `restoreChild` requires the original child creation request. Neither creates anything; absence does not exclude a concurrent creation. `configure` advances the Session revision on every committed choice, including identical values, fencing older configuration CASes without changing event history.

## Terminal apps

Host plugins use `ctx.tui.app(name, { read, submit, recover? }, descriptor)` to contribute a TUI application without a Desktop bundle or a new Maka binary. The descriptor selects `page`, `panel`, `status`, `settings`, or a named `slot`; its `context` is `application` or `session`. A view can embed `tui.slot(...)` to compose contributions from other plugins.

`read(route, cx)` returns a View v5 body built with `ctx.tui` (columns, rows, splits, tabs, text, Markdown, controls and fields). The SDK adds the version. Stable sibling keys preserve focus and editing state; `cx.t(en, zhCN, zhTW)` selects the reader's language. The shell owns layout, local typing, scrolling, confirmation and draft recovery. Plugins use semantic tones and never emit terminal escapes.

Tabs and columns of items each contribute one keyboard Tab stop; arrow keys move inside them. Reentering a group restores its last focused item. A list column may include decorative text, Markdown, code, rules or progress; put fields and buttons outside it so each remains reachable with Tab. Focus changes alone never submit an action or follow a plugin route.

`submit({ route, revision, action, fields, grant }, cx)` applies an explicit user action and returns `applied`, `conflict`, `rejected`, or `consent`. Use the revision for storage CAS and enforce domain authority in the Host. Declare an action's `recovery` route only when `recover(route, cx)` can look up its durable outcome; the shell never blindly replays an uncertain write.

For live updates, `const changed = await ctx.tui.changes('changed')` registers a stream. Set `changes: 'changed'` on the descriptor and call `changed()` after committing data. Invalidation is coalesced; the shell rereads clean views and preserves edited drafts. Subscriptions and controls retire with their registration.

Use a transcript resource for paged history and streaming text. It shares native Chat's Markdown, grouping, selection and local search, while keeping data outside the View's 64 KiB budget:

```js
const key = { turn: 'build-42', message: 'log', part: 'text' };
const log = await ctx.tui.transcriptResource('build-log', {
  blocks: [{ key, revision: '0', kind: 'assistant', content: { text: 'Started\n' } }],
});
ctx.effect(() => log.close());
// Return this node in a view; append when the observed work produces text.
const reader = ctx.tui.transcript('log', log.resource);
log.append(key, 'Finished\n', '1');
```

`replace`, `append`, `remove` and `timing` publish contiguous resource updates without rereading the View. Record keys and revisions are stable presentation identities; they grant no native Session, file or mutation authority. Surrounding actions still use the usual authorization, CAS and recovery contract. `Ctrl+F` finds within the loaded page; End or the new-content marker follows the tail. Selecting text pauses following.

The helper owns document-scoped snapshots, cursors and cancellation. It retains at most 4,096 records / 32 MiB of source; pages retain up to 256 records / 4 MiB, with one larger record allowed up to 16 MiB. Large records use ordered UTF-8 JSON fragments within Remote's message budget. An exhausted update queue explicitly invalidates the reader. Rust providers can serve the same [public records and resource protocol](../../crates/plugins/src/terminal_ui/transcript.rs) through ordinary Remote method/stream handlers; resource endpoints must belong to the containing view's exact entry and activation. A slot's context should contain stable entity identities, and its node key must distinguish independently editable entities.

The [Board example](../../crates/cli/tests/fixtures/board-plugin/host.mjs) includes three columns, nested card editing, storage CAS and live refresh. Its [PTY test](../../crates/cli/tests/integration/tui/board.rs) installs it while the TUI is running, interacts with it and checks the persisted domain data.

## Usage

`session.inspector.overview` receives the viewed Host's canonical `sessionId` and `locale`. It augments the overview without replacing native trace/context controls. Bind Remote reads to that Session; slot props alone grant no execution permission.

`call.usage.activity({ kind: 'start', filter: { from, to, sessionId?, activity? } })` reads physical model and tool attempts, including failed retries, auxiliary calls and pre-dispatch refusals. Agent calls see their Session; independent calls need `read_usage` authorization for a profile or Session. Responses contain no conversation bodies. Missing usage, price and outcome remain distinct unknowns.

Activity entries are tagged `model` or `tool`. Optional `activity` filters select `kind`, `status` and a literal ASCII-case-insensitive `search` (at most 1 KiB UTF-8, no control characters). Refusals have no execution duration; unknown tool effects are not cancellations.

Each page contains at most 100 attempts / 48 KiB. `{ kind: 'continue', cursor }` re-reads that page; `nextCursor` advances under the same filter and settlement fence. Host restart invalidates cursors; every read checks current authorization.

`{ kind: 'refine', cursor, selection }` changes activity filters and returns the first matching page without changing the original scope, range or fence.

`call.usage.summary(cursor)` uses the same range, Session and fence, ignoring activity-only filters. Token and cost subtotals include missing-call coverage; unpriced calls differ from priced calls with incomplete usage. Provider/model/tool breakdowns are complete or fail explicitly (128 groups each, 48 KiB overall). Pending counts use admission time within the range and are excluded from completed totals. Nonfinite or inexact integer aggregates fail rather than becoming zero.

Summary `durationMs` totals observed model/tool execution time, excluding unknown outcomes and pre-dispatch refusals. Overlapping calls are cumulative, not Session wall-clock time.

## Pricing

`ctx.pricing.query({ kind: 'start' })` reads the public rate catalog during activation. Continue with the returned revision and `nextOffset`; `revision_changed` requires a new scan. `call.pricing.update({ expectedRevision, mutation })` requires explicit profile `manage_pricing` consent. Edits share the native CAS and configuration notices, affect future admissions only, and finish after admission even if the caller stops waiting. A lost reply can yield `revision_conflict` on retry; query before choosing another edit.

## Behavior selection

Tool capture receives a frozen `behavior` identity, or `null` when unavailable. It is
observation for tool visibility, not execution authority. Native and JS bindings share this field.

Ordinary Session selection qualifies behavior registrations by collaboration mode: Agent uses
the configured name, Plan uses `<name>:plan` (for example `default:plan`). Missing registrations
fail admission. An authorized explicit per-Turn behavior selects its registered name directly;
the actual selected identity is frozen with execution and restored on continuation.

## Model adapters

`ctx.modelAdapters.register(name, open)` publishes a protocol adapter. `open('request' | 'conversation')` returns `stream(request, context)` and optional `confirm(history)`. Rust uses `maka_plugins::model::ProviderAdapter` and the same typed events, HTTP and WebSocket contracts. Model overrides select an adapter by `adapter`; defaults are `responses`, `chat-completions` and `anthropic-messages`.

Host freezes the registration per logical step, resolves credentials, and owns admission, cancellation, budgets and canonical settlement. Adapters receive resolved secrets: do not log requests or credentials. They encode protocols, emit events with backpressure, and classify retry safety. HTTP bodies expire with their call; sockets belong to the disposable adapter session. Rebinding a socket uses the next call's transport. Changed routing identity invalidates cached connections. Missing or retired selections fail without silently switching implementation.
