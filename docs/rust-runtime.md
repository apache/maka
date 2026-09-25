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

# Rust runtime host

[简体中文](./rust-runtime.zh-CN.md)

The Rust workspace replaces Maka's runtime and host while preserving the
TypeScript client protocol and interactions. Both use protocol epoch 179. The rewrite is incomplete;
unsupported operations return explicit errors.

## Build and run

Requires Rust 1.98+, a native C/C++ toolchain, Node, and the repository's npm
dependencies. Provider SDKs and the terminal parser are bundled at build time;
the executable does not require Node at runtime.

```sh
npm install
cargo build --locked -p maka-cli
cargo run --locked -p maka-cli -- --help
npm run dev
```

Desktop defaults to the Rust host, using `userData/runtime-host-rust`. Existing
TypeScript State Roots are not migrated or adopted. Use a new root for standalone
execution:

```sh
maka host init --root /absolute/path/to/new-root
maka host serve --root /absolute/path/to/new-root
maka host status --root /absolute/path/to/new-root
maka host retire --root /absolute/path/to/new-root
```

The native `maka` executable opens its TUI when no subcommand is supplied;
`maka tui` is the explicit equivalent. Use `maka --root /absolute/path/to/root`
or `maka tui --root /absolute/path/to/root` to connect to an existing native Host.
The default root is the account's native `runtime-host-rust` installation root,
not Desktop's `userData` root. Startup does not create, migrate or stop a Host.
This initial TUI slice provides keyboard/mouse navigation, a command palette,
appearance switching, live Host status and a paginated session catalog. Open a
session by mouse or keyboard to inspect its identity, workspace, model and latest
preview. Catalog notifications refresh views; revision changes restart pagination
instead of mixing snapshots. Session pages have independent in-memory drafts with
grapheme-aware editing, soft wrapping, mouse selection and undo/redo. Enter inserts
a newline, Ctrl+A selects all, Ctrl+Z/Ctrl+Y undo/redo, and Tab leaves the editor.
Bracketed paste is a single undoable edit; terminal controls are rejected. Drafts
are limited to 256 KiB each and 32 per running client, with bounded undo history;
they survive navigation, reconnects and restarts. Drafts, preferences, reading
bookmarks and navigation history are saved per Root/client profile. Use `--profile
NAME` for independent clients; one writer owns each profile. Unconfirmed sends
retain their original identity and are never automatically resent. Undo history
and transcript text selections are not restored across processes.
Use Ctrl+P in a session or with a selected catalog row to rename, archive or
restore it. The centered dialog supports keyboard and mouse; archiving defaults
to Cancel and retains history and drafts. Archived sessions remain accessible
from the workspace. Renames use the Host's revision check; conflicts and unknown
outcomes are never retried automatically. Acknowledgements update only their
original session without navigating away. Background catalog refreshes retain
row positions instead of inserting loading notices above existing content.

Settings → Model connections shows a paged overview of enabled models and the Host
default; it also follows configuration changes from other clients. This nested
page supports Back/Forward and reopening without adding a sidebar item.
Use its ⊕ button or Ctrl+P → Add model connection for API-key setup for OpenAI-compatible,
OpenAI and Anthropic providers. Verify discovers models without saving; select
models and explicitly save the connection and key together. Keys stay masked and
are not saved in TUI state. If the Host has no default model, its first selected
model becomes default.

Select a connection and press Enter or click ✎ to rename it. Ctrl+P also offers
enable, disable and remove; these confirmations default to Cancel. Renaming and
toggling preserve the endpoint, enabled model IDs, overrides and credentials.
Disabling clears a default that uses this connection; enabling does not restore it.
Removal permanently deletes the connection and its saved credentials, but keeps
chat history. All changes use the Host's connection revision check; unknown
outcomes require a fresh read, never an automatic retry.
Use the connection page's ☆ button or Ctrl+P → Default model to choose the Host
default. Select a model, then confirm; to clear it, select No default model and
confirm Clear default. Only new sessions requesting the default are affected;
existing sessions and drafts stay unchanged. Configuration changes withdraw the
selection, and the Host checks the catalog revision before saving.
Ctrl+P → Change service address edits non-OAuth connections. Review the full
destination before confirming; saved credentials will be used there. Changing
the address clears discovered models, model overrides and test results, but keeps
enabled models and request overrides. The confirmation defaults to Cancel.
For API-key connections, Ctrl+P → API key shows whether a key is configured and
lets you replace it without revealing the saved key. The new value stays masked,
is not saved in TUI state, and is discarded from the form on submission or disconnect.
Saving is revision-checked; it does not test the key. Clear API key defaults to
Cancel and removes only the Host's saved key, not the key at the provider.
Ctrl+P → Fetch models queries the connection's currently configured service with
saved credentials and saves the inventory after confirmation. Existing enabled
selections are preserved; first discovery on an empty connection may enable its
first model, without setting a Host default. The Host rechecks effect-relevant
configuration before committing; this operation has no client revision precondition.
Failures stay in the dialog, and uncertain outcomes are never automatically retried.
Model-settings editors and OAuth UI are still pending.

For an unarchived AI SDK session, click the model name on the composer's lower
border or use Ctrl+P → Change model. Choose an enabled chat model from the Host's
catalog, then confirm. This uses the selected model's default thinking settings;
the Host default, other sessions, sandbox and draft stay unchanged. Concurrent
changes are revision-checked and uncertain writes are not retried automatically.

For an unarchived session, Ctrl+P also offers Change workspace. Enter an existing
absolute directory on the Host; this changes future execution's working directory,
not file locations. A project-backed session switched to a fixed directory no longer
follows the project's location. The Host rejects busy or non-relocatable sessions;
conflicts and unknown outcomes are not retried automatically.
Ctrl+P → Change project binds an existing session to a registered project, with
its directory resolved by the Host. Nothing is preselected; select a row and use
Enter or Use project to confirm. Archived or unavailable projects cannot be applied.
This changes only the selected session, preserves its draft and uses its revision
check; it does not merge projects or move files.

Projects (sidebar or Ctrl+P) lists the Host's registered projects. Select a row
with the mouse or arrow keys, then use Enter or + to create a session bound to
that project. The Host resolves its current directory; archived or unavailable
projects cannot be used. Project changes refresh the list without rebinding a
selection to a different row. ⓘ or Ctrl+P → Project locations shows registered
Host directories, including the preferred directory and worktree markers. Long
paths wrap; arrows or the mouse wheel scroll, PageUp/PageDown change catalog pages.
The read-only view refreshes after project changes. Use ⊕ or Ctrl+P → Register project with an existing
absolute Host directory, or choose Browse to navigate the directories published
by that Host. Enter opens a directory; Register here (or Ctrl+Enter) registers the
current one. Backspace goes up, PageUp/PageDown change pages, and Esc returns to
the path editor without losing its draft. Ctrl+P also offers project rename,
archive and restore.
Archiving keeps existing sessions and files but prevents new project sessions;
confirmation defaults to Cancel. Project mutations follow the Host's serialized
commits, without session-style revision checks. Unknown outcomes
are not retried automatically. Ctrl+P → Relink project accepts a replacement
absolute Host directory, then asks for confirmation (Cancel is selected by
default). Relinking replaces the project's locations and updates its sessions;
if the destination belongs to another registered project, the Host merges it
into this one. Files are not moved. Edit path returns to the input; an unknown
outcome blocks editing and resubmission until the dialog is closed and state is
checked. Relinking is not a promise to move already-running execution.

The Inbox lists sessions with unresolved approvals, questions or forms, including
sessions not opened in this client. Its filled diamond indicates pending work;
background updates never open a dialog or move focus. Open a session to review
its current requests, then use Alt+Left to return. Session fullscreen exposes an
Inbox icon while attention is needed. The native Host supports `pending_start`
and `pending_continue` on `session.catalog.query`; the legacy TypeScript Host
returns `operation_unavailable` for these new query kinds.
Use + (or Ctrl+N in the workspace) to create a session in the process's current
directory with the Host's default model. Ctrl+S or the send icon submits the draft;
Enter still inserts a newline. Acknowledgements clear only an unchanged sent draft.
Unknown outcomes retain the draft and replace the send icon with a delivery check
(Ctrl+R), which queries the original message ID without resending. A confirmed
receipt clears only the unchanged draft; confirmed cancellation keeps it for an
explicit new send. An absent receipt is not proof of non-delivery: sending stays
disabled, editing remains available, and delivery can be checked again after
reconnecting to the same Root.
Session pages now consume snapshot/ready subscriptions, reconstruct byte fragments
with digest checks, and reconcile UTF-16 live streams with durable messages.
Reopening reloads Host history. Use the earlier-messages icon for older pages,
the mouse wheel over the transcript, or PageUp/PageDown outside the composer.
Assistant text now has basic Markdown styling (headings, emphasis, lists, code and
visible link destinations). Message triangles fold/expand content; thinking and
tool records start compact. Outside the editor, Space toggles the top message and
End returns to the latest output; a down-arrow control appears when not following.
Message/source-position anchors preserve reading across new output, older-page
loads and width changes. Completed messages keep their layouts while live text
updates; manual folds survive live-to-durable replacement. Folds and anchors are
currently local to the open page, not saved across route changes or restarts.
Tables preserve cell styling, allocate widths by content, wrap cells and honor
left/right/center alignment; very narrow screens switch to labeled fields.
Live Markdown caches closed top-level blocks and reparses the open tail. Documents
containing square brackets still use full parsing so later reference definitions
cannot invalidate cached links; large open blocks also still require full reflow.
Code syntax highlighting, selection/copy, search and semantic tool cards remain incomplete.
Pending interactions expose a compact ! action (Ctrl+A outside the editor).
The review dialog shows the original Host request and identity, supports mouse
and keyboard scrolling/choices, and defaults to Later, which leaves it pending.
Permission requests can be denied or granted once, for the turn, or for the session;
producer requests without a tool identity cannot receive a once-only grant.
Client-capability approval explicitly grants the displayed provider/contract/scope
for the session. Unknown outcomes only permit querying the original request;
disappearing requests lose their approval buttons, and replies are bound to the
original session, interaction, turn, run and request.
Questionnaires have compact question tabs, radio choices with descriptions,
grapheme-aware custom input (2,048 UTF-8 bytes per answer), and explicit skipping.
Every question must be answered or explicitly skipped before Ctrl+S / Submit is
enabled; Enter in custom input inserts a newline. Unsent answers survive Later
and returning to the same pending request in this process, but are not persisted
across restarts or retained if replaced by another review. The dialog sizes to
its content and scrolls longer questions. Forms still require another client;
structured form editors, a global pending inbox and richer tool cards remain pending.
Current limits are 16 MiB per assembled message, 32 MiB per batch and retained
history, 2,048 retained messages, and 131,072 layout rows / 64 MiB of estimated
layout storage; capacity failures are explicit.
The shell prioritizes content: Ctrl+B toggles an expanded navigation sidebar and
compact icon rail; narrow terminals start with the rail. F11 toggles session focus
mode, and the info icon reveals session metadata. The composer grows with its
content up to a bounded height. F5 and the command palette refresh the current
page; catalog notifications continue to update it automatically. Hover an icon for
its tooltip, or focus it with the keyboard for a status-line description. Settings
offer ASCII icons and reduced motion; sidebar transitions stop rendering when idle.
Use Ctrl+P for commands and Ctrl+Q to leave the UI without stopping the Host.
Piped stdin/stdout are rejected without entering terminal modes; explicit Host,
Code Mode, inspect and sandbox subcommands retain their existing behavior.
This does not replace a separately installed legacy TypeScript CLI on your PATH.

TUI language selection uses `maka --locale zh-CN` (or `maka tui --locale zh-CN`),
then `MAKA_LOCALE`, the saved profile preference, then automatic system detection. Supported values are `auto`,
`zh-CN`, `zh-TW` and `en`; `zh` aliases `zh-CN`. Explicit `auto` ignores
`MAKA_LOCALE`. Automatic detection honors the first nonempty `LC_ALL`,
`LC_MESSAGES`, or `LANG`, then the native system locale; unsupported languages
fall back to English. Invalid explicit preferences fail clearly.
Settings lets you cycle languages using mouse or Tab/Enter without reconnecting
or resetting navigation. Language and palette changes are saved to the client
profile. Host diagnostics and business data retain their original language.
Core TUI text lives in `crates/tui/locales/*.ftl`; missing/invalid translations
fall back to English with deduplicated diagnostics shown in Settings.

Desktop opens its navigation and draft editor before Host readiness. An unavailable
Host does not exit the app: retry, switch Host, copy diagnostics, or quit. Draft text
is stored by Desktop, never in a send queue; an offline send is rejected and retains
the draft. Startup reports `mainInteractiveMs` and `hostReadyMs` separately.

Session drafts persist text, attachments, references and revision intent in Desktop's
authority-scoped SQLite store. Version navigation includes unsent revisions. Restoring
a draft never sends it; submission atomically moves the selected version into the local
outbox, retaining later edits. Closing flushes drafts before Host shutdown; an unconfirmed
save keeps the window open unless the user explicitly discards it.

Finite CLI commands accept `--timeout-ms` (1–600000): status/logs default to 15 seconds,
other operations to 180 seconds. Desktop recovery has one 45-second budget and at most
five attempts; quit has one 8-second budget including cleanup. Substeps use the remaining
budget. Download progress reports bytes; unchanged heartbeats do not reset stall detection.
Timeout ends observation, not accepted work or its locks. A one-shot command
worker may finish afterward; it is not a resident controller. An unconfirmed result must
be checked with `host status` before retrying. `operation: in_progress` denotes an executor
lease, independently of normal Host activity. Pending updates are reconciled from their
saved target; uncertain owners are never killed and locks are never deleted for recovery.

Use `target/debug/maka` if the binary is not on PATH. Local transport is a Unix
socket on Linux/macOS or a private named pipe on Windows. An optional
`--websocket 127.0.0.1:0` listener requires authentication; TLS is not implemented.
Against a running Host, `host access prepare --root <directory> --principal <id>`
prints pairing JSON containing a secret. Keep it private. It expires after 15
minutes unless the importing client finalizes it, then reconnects with the same
client identity. This Desktop-owner policy does not grant arbitrary Host paths.
`host access revoke --root <directory> --credential-id <id>` revokes it and closes
its remote connections. These commands neither start the Host nor migrate data.
Development builds retain line-number backtraces; `CARGO_PROFILE_DEV_DEBUG=full`
enables full debugger information.
Windows MSVC builds use the static CRT required by the official V8 archive.
The two vendored Deno TypeScript files must match `deno_telemetry` exactly;
update them together when upgrading that dependency. They avoid a build-time V8.

`host connect --root-id <rootId> --framed` activates that deployment and bridges the
client protocol over stdin/stdout; diagnostics use stderr. Linux/macOS input EOF
half-closes the connection and drains responses. Windows pipe EOF disconnects;
clients must receive their responses before closing stdin. WSL passes
`--repair-root-after-remount`: this explicitly confirms an unchanged Linux inode
after remount, preserving Root ID. Do not use it to adopt copied or legacy roots.

`host install --root <directory>` pins the current executable and on-demand policy;
`--mode supervised` selects persistent serving. Only the returned `executable`
may start that managed root. `host activate --root-id <rootId> --framed` reuses a ready
Host or starts the pinned executable. In supervised mode, activation registers and
starts an account-level systemd service, LaunchAgent or Windows scheduled task.
Linux requires an active user manager with lingering enabled; macOS requires an
Aqua login and Windows an interactive user session. Installation alone does not
start a service or change account policy.
`host setup --root <directory>` combines installation and activation; optional
`--principal <id>` also returns a short-lived Desktop pairing credential. Protect
this JSON as a secret. Interactive launchers use `--framed` and hide the reserved
`__MAKA_NATIVE_HOST_SETUP__` result line. Repeating setup preserves the existing code and
unspecified configuration; changes still require `host update`. Without `--root`, install/setup
use the account's native `runtime-host-rust` directory, separate from legacy TS state.

`host fetch --target <target> --version <exact-version> --cache <directory>` prepares
`@maka-agent/cli-<target>` from npm without installing or starting a Host. Targets:
`darwin-arm64`, `darwin-x64`, `linux-arm64-gnu`, `linux-x64-gnu`, `win32-x64`.
It verifies SHA-512, package identity and binary headers; validated cache hits work
offline and recheck file hashes. CLI proxy environment variables apply. Local
packages use `--archive <file.tgz> --integrity sha512-<base64>` instead of npm.
The returned JSON identifies both Windows executables. `--directory <verified-package>
--receipt-sha256 <digest>` imports a transferred package against its original verifier's receipt.
The default cache is the account's `native-cli` directory; saved profiles reference its executables.
Native preview packages use the separate `rust-preview` npm channel, never `latest`.

Linux releases target glibc 2.28 or newer. `node scripts/rust/build-cli.mjs --release`
uses `cargo zigbuild` with an explicit `x86_64-unknown-linux-gnu.2.28` or
`aarch64-unknown-linux-gnu.2.28` target; install cargo-zigbuild and Zig on the build machine.
Development builds still use ordinary Cargo. SSH/WSL onboarding rejects older glibc before downloading.

Desktop SSH/WSL onboarding downloads and verifies its `nativeRuntimeHostVersion` pin locally,
transfers the complete package, removes upload staging, and sets up the native Host.
The pin is an exact npm version, independent of the Desktop version; packaging can select it
with `MAKA_NATIVE_CLI_VERSION`. Published previews cover macOS arm64, Linux x64 and Windows x64.
The target needs no Node/npm/Rust. Development builds
can set `MAKA_NATIVE_CLI_VERSION` and `MAKA_NATIVE_CLI_PACKAGES` (a `host fetch` cache directory).
These overrides are ignored in packaged Desktop. Existing profiles start offline.

Desktop paints its main window before loading Host services. Registration waits
and document loads are bounded; Host failure leaves drafts, management and quit
available. Handoff decisions appear in the main window, not a second startup window.

Desktop reuses managed native Hosts and activates pinned code when needed;
its own generation and exit do not govern their lifetime. Pausing local launches
waits for outstanding activations before handing off the Root.
Desktop can manage local native deployments and existing SSH/WSL native-operator
profiles. Remote lifecycle commands use SSH/WSL OS authority, not WebSocket
credentials. Stop/uninstall retain the connection pause. Start/restart/update
resume normal reconnection even after an unconfirmed result; activation checks
the actual deployment rather than replaying the mutation.
Deployment authority lives in account-level
SQLite, outside the State Root; startup checks it before database migrations.
On Windows, supervised installations use the sibling `maka-service.exe`, a
windowless entry to the same Host. Distribute it alongside `maka.exe`.
On-demand activation requires permission to leave the launcher's Windows Job;
run the built executable directly, not through `cargo run`.
Once shutdown begins, the CLI allows ten seconds for cleanup before exiting with
code 70. Interrupted work is recovered from the log, never assumed rolled back.

For a code update, run the new binary with
`host update --root-id <rootId> --expected-deployment-id <deploymentId> --expected-revision <revision>`.
The same update can set `--mode`, `--websocket`, and repeatable
`--project-root-json '{"label":"Projects","path":"/absolute/path"}'` declarations.
`--no-project-roots` publishes none; `--default-project-roots` restores the account
default. Omitted settings are preserved. Code and configuration share one target
and revision; `reconcile` never selects different settings.
Active clients or non-cooperative work defer the switch; `host reconcile` with the
same identity arguments finishes the recorded update. A committed target is never
automatically rolled back, even if startup fails. Supervised activation replaces
the service definition only while holding the Root. Upgrades target recoverable
restarts, not uninterrupted sockets or PTYs; no separate control daemon is planned.

`host upgrade` takes the same identity arguments, downloads `rust-preview` (or an exact
`--version`) before handoff, and delegates the update to that package. Desktop also prepares
downloads and SSH/WSL transfers before pausing connections.
`host update-policy --root-id <rootId>` reads the automatic-update policy. To change it, add
`--policy rust-preview|manual --expected-policy-revision <revision> --expected-deployment-id <id>`.
The default is manual. Automatic updates use an independent OS timer/task, not a resident daemon;
checks succeed at hourly intervals, with ten-minute retries for failures or busy work.
Idle clients reconnect after a switch; running work, PTYs and OAuth defer it.
On-demand Hosts remain asleep until a client activates them. Disabling the policy fences queued
updates; uninstall also removes the task. `lastError` reports attempt failures and
`schedulingError` reports a saved policy whose OS task needs repair by repeating the request.

`host stop`, `host restart` and `host uninstall` take the same identity arguments.
Stop and restart preserve pending updates. Uninstall revokes startup before removing
the service; it retains Root data, packages and a deployment tombstone. Retry the
same uninstall if `cleanup.kind` is `pending`. Explicit installation grants a new
deployment identity after the old service has been removed.

`host status --root-id <rootId>` reads the deployment, pending update, OS service
and live Host independently; it never starts or repairs them. An unavailable Host
is not proof that its process stopped. `host logs --root-id <rootId>` returns up to
48 KiB of supervised diagnostics, with `byteTruncated` marking omitted bytes.
Linux selects the latest 200 journal entries; macOS/Windows read stderr. These are
diagnostics, not execution history. On-demand stderr is not captured.
Supervised activation failures include the observed service state, PID/result when
available, and a bounded recent log tail. Diagnostic reads share the activation
deadline; the tail may include records from earlier attempts.

The `maka` command also provides `host candidate` for Desktop-owned startup,
`code --log <file>` for a JavaScript cell read from stdin, and
`inspect --log <file>` for committed execution facts.

**There is no OS sandbox.** Code and tools execute with the user's OS permissions.
Do not run untrusted code or point test instances at existing user data.

## Design

Native plugins receive private files through `PluginContext.data`, namespaced by
package and scope. File workers retain their Fiber until completion; retirement
rejects new operations without deleting data. Root validates core files and directory
safety, not business names. Plugins own file formats, locking and recovery; existing
user/project content paths stay separate from private journals.

- **Log Is the Runtime:** model history, transcript and recovery derive from
  committed semantic facts. Compaction changes the model projection, not history.
  Failed response fragments remain display evidence, not accepted model history;
  user cancellation is not displayed as a provider failure.
- Accounting counts physical model admissions, including failed retries and auxiliary
  plugin calls. Provider usage survives rejected output; missing counters and unresolved
  outcomes remain unknown. History copies do not duplicate usage, and Session removal
  retains accounting facts. Pricing queries and CAS edits use a bounded, revision-pinned
  catalog; custom rates survive restart and bundled-rate updates invalidate old cursors.
  Rust/JS plugins share this catalog and mutation path; edits require explicit profile
  pricing consent and cannot be authorized by an Agent invocation alone.
  Each admission captures its public provider identity and rate decision; estimates commit
  with reported usage and survive rejection, edits and recovery. Public Rust/JS Usage reads
  recheck scoped authorization and return at most 100 rows / 48 KiB under a fixed settlement
  fence, with one filtered activity page across model calls, tool effects and refusals.
  Continuation cursors expire on Host restart. Summaries share the activity fence, preserve missing-counter/
  price coverage, and bound complete provider/model/tool breakdowns. Pending admissions remain separate.
  Usage screens are not yet connected.
- Subscriptions deliver frames only after `subscription.ready`. Reconnection replays
  active text from the committed log under backpressure; no copied transcript overlay.
- Model messages, content and tool outcomes are typed through provider projection.
  Routing and discovery share typed provider contracts. Tool JSON, schemas and
  provider extensions remain open-ended.
- A State Root has one writer and execution authority. Session, Turn, Run and
  invocation identities remain distinct. Cooperative continuation preserves the
  public Run identity; claims and cleanup still address exact physical Runs.
  Sealed work can be cancelled without loading a provider or repeating effects.
- Host diagnostics and retirement share active-work accounting, including pending
  OAuth authorization. Retirement targets an exact Host epoch and retains authority
  through response flush and resource cleanup. Cooperative handoff seals settled
  steps and resumes their frozen composition after restart; missing client owners
  leave work paused. Preparation can be withdrawn before sealing and never grants
  permission to interrupt other connected clients, PTYs or OAuth flows.
  The legacy `nodeVersion` field reports `not applicable (Rust)`.
- Manual resume checks a sealed source without claiming it, then atomically opens
  a new continuation. Replay follows the selected lineage, excluding later branches
  and unfinished response fragments. Unknown effects block admission; repeating
  the same admitted request returns its original Turn, including after restart.
- Typed model inventory flows from discovery through storage and catalog projection;
  connection-owned overrides remain separate. Proactive compaction reserves maximum
  output and input-growth headroom within the total capacity;
  see [Context windows and compaction](#context-windows-and-compaction).
- Tool dispatch commits before effects; outcomes commit afterward. An uncertain
  outcome is not permission to repeat an effect. Cancellation drains admitted work.
- Permission-only grants can widen during execution. New tool calls capture the
  committed boundary; narrowing waits for quiescence and native resource cleanup.
- Read uses `path` for files and Session resources, with bounded pages and
  content-checked continuations. Event addresses expose frozen model evidence,
  not omitted raw output. Large text results persist a bounded first page before
  the next model request; media and original execution facts remain intact.
- Deferred tools become callable on the step after a successful search; committed
  compaction unloads them. Code Mode exposes only `exec`, with the available
  nested catalog in its description. Existing calls retain their captured scope.
  Each logical step captures schemas and handlers together; physical retries
  and returned tool calls reuse that view.
- Explicit Skills in `turn.start` and `turn.message.submit` freeze instructions and receipts at
  admission. Queued messages retain their required tools; promotion and successor
  execution check the actual target Run without reloading Skill files.
- `SkillSearch` and `Skill` bind one inventory, handlers and supporting context per logical model step.
  Physical retries keep that snapshot; the next step can observe changes.
  Discovery exposes bounded metadata; loaded instructions retain readable archive pages.
- The agent-mode Skill selector previews current permissions without binding a Session or
  resolving a model. Bundled and local-library source catalogs report actual installation
  occupancy and validated managed-source aliases. Governance exposes validation,
  preferences and source updates without reading baselines or claiming Run advertisement.
  Catalog views share a revision; cursors also bind their view. The `maka.skills` built-in
  owns discovery, input expansion, enable/pin CAS, raw-byte update previews and recoverable
  creation/install/delete/update. Its Client bundle supplies management, selectors and draft suggestions.
  Discovery-directory management uses the same location definitions, public Remote file grants and
  target-bound native opening. A missing Project does not hide user/private directories; stale paths
  are rejected without replaying the action. User file management is authorized separately from Agent calls.
  Desktop supplies target-bound Slots and authorized native file actions. Disabling the plugin
  rejects new explicit Skills without blocking ordinary chat or rewriting accepted receipts.
  Plan-mode execution remains outside this domain and is not implemented.
- Rust owns storage, network routing, tools and native process/PTY lifetimes.
  Plugins enter through catalogs and scoped Host services, sharing
  journaled effects, permissions and draining rather than replacing the Engine.
  Responses uses a native Rust adapter. Other protocols retain AI SDK on one
  lazy, long-lived V8. Both are ordinary model-adapter plugin contributions;
  logical steps freeze their registration through retries. Native PTY workers
  own their Alacritty terminal state without JavaScript or cross-runtime messages.
  Code Mode cells use separate short-lived isolates. Count and byte limits provide
  backpressure; V8 heap limits are not process-memory containment.
- Code Mode budgets cumulative VM execution, excluding asynchronous tool waits
  and cleanup.
- Responses reasoning follows the declared encrypted, plaintext-content or plaintext-summary
  contract. Summary replay preserves item identity and Unicode-safe part boundaries without
  storing a second copy of its text; malformed metadata is not replayed.
- Request-scoped proxy policy applies to HTTP and Responses WebSocket transport.
  An enabled manual Host proxy takes precedence; otherwise the Host captures
  `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY` and `NO_PROXY` (uppercase before lowercase).
  A scheme-specific proxy wins over `ALL_PROXY`; `NO_PROXY` supports domains and
  subdomains, IPv4/IPv6 addresses and CIDRs, and `*`. To force direct routing without
  a manual proxy, clear the proxy variables or set `NO_PROXY=*` before starting the
  Host. Restart an already-running Host with the new environment; a supervised
  service gets its environment from its service manager, not a later TUI shell.
  OAuth, model discovery and authorized tool networking share this policy;
  sandbox CONNECT uses the HTTPS route regardless of destination port and still
  checks destination permissions before connecting. Proxy failures never trigger
  direct fallback. HTTP, HTTPS, SOCKS5 (local DNS) and SOCKS5H (proxy DNS) URLs are
  supported; invalid proxy values are rejected without echoing credentials.
  Environment credentials are not persisted. In CGI environments,
  `HTTP_PROXY`/`http_proxy` are ignored.
  Failed WS handshakes retry five times with exponential backoff, then use HTTP
  through the same policy. Separately, main requests allow up to ten attempts for
  identified transient provider or native network failures, using frozen inputs and cancellable backoff.
  Provider tool activity or replay metadata blocks retries. Unknown/local errors
  and unclassified network failures or idle timeouts are not retried.
  Model activity refreshes the 120-second idle budget; active streams have no fixed
  two-minute duration limit. User cancellation still closes and drains the request.
  A real provider finish releases the stream without waiting for transport EOF;
  synthetic finishes from truncated streams are not successful completions.

## Context windows and compaction

Model configuration uses `contextWindow` for the **total input-plus-output capacity**.
Native AI execution requires this value from the provider catalog or a model profile;
`inputLimit` alone cannot replace it. Catalog/settings remain available to repair
missing capacity. ACP executors and deterministic Code execution own their contracts.

```text
auto threshold = floor(85% × min(contextWindow, inputLimit if known))
threshold      = explicit compactionThreshold, otherwise auto threshold
```

For a **1,000,000-token window**, the default is **850,000 tokens**, independent of
whether the requested maximum output is 128,000 or 64,000 tokens. An independent
800,000-token input limit lowers the default to 680,000. The sole optional
`compactionThreshold` override remains an absolute token count.

Before a Main request, positive input usage from the latest matching Main request
can trigger compaction by itself. Otherwise output usage must also be known before
comparing input + output. Unknown counts never become zero. The observation must
match model, connection, route, checkpoint and effective history projection.

Each request has a finite output budget: the resolved request budget, otherwise
its known provider output ceiling, otherwise 8,000 tokens. Provider policy caps it
at the known ceiling. With complete matching usage `R` and total window `C`, output
is further limited to `C - R - 8000 - fixed thinking`, with a useful floor of
`min(selected budget, 8000)`. Anthropic's text/thinking conversion is applied once.
Without that usage anchor, including after compaction, the selected budget remains
unchanged. Summary text is capped at the smaller selected budget and 8,000 tokens.
These are request limits; they never rewrite configured model capacity.

Compaction captures a settled prefix and freezes its model, adapter and source for
bounded summary repairs. When the model executor has spare capacity, summary work
runs beside Main requests; otherwise the same compactor runs synchronously. A
candidate is adopted only before a new Main request, preserving the exact prefix
and all appended messages/tool results. Pruning waits while a candidate exists.
Cancellation, completion and handoff cancel and drain outstanding summary work
before the invocation seals. Only new accepted Main work renews automatic attempts.

Observed usage and the growth reserve are heuristics, **not a proof that the next
prompt fits**. New text, tools or media may still overflow. Only an explicit provider
context-overflow rejection before observable output triggers bounded automatic
compaction/retry; summary overflow fails without recursive compaction. Display
estimates never authorize request admission.

A valid, closed output-length response is retained but ends the Turn with
`model_incomplete`; its local tool calls are durably rejected and never dispatched.
Malformed partial calls and unresolved provider effects remain strict failures.
There is no automatic prose continuation. Explicit resume retains its existing
stable-effect replay policy; a new user message can refer to the saved partial text.

Internal request evidence distinguishes `ModelRequestContext.context_window`
(the effective input ceiling), `model_context_window` (total capacity), and
`declared_window` (the resolved trigger). Historical missing fields remain unknown.
See [Host resolution](../crates/runtime-host/src/execution/provider/context.rs),
[usage and output checks](../crates/agent/src/auto_context.rs), and
[compaction lifecycle](../crates/agent/src/steps.rs).

## Web

The `maka.web` plugin publishes WebFetch and WebSearch. Settings → Web search
selects model-native search or Tavily and stores its key in plugin-scoped credentials.
OpenAI/Codex default to native search capability; explicit model declarations win.
Compatible endpoints must declare support. The selected wire must support provider
tools: Responses and Anthropic Messages are implemented; the plaintext
OpenResponses adapter does not support them. No automatic source fallback occurs.

WebFetch uses authorized Host HTTP without a browser or page JavaScript. It prefers
Markdown and extracts readable HTML, retaining links and code. Responses are limited
to 5 MiB, extracted text to 50 KiB and redirects to ten; clipped output is explicit.
Tavily queries accept 1–200 characters and return at most ten results, with omitted
results and clipped snippets marked. Incognito mode withdraws both tools.

## Session checklist

The `maka.todo` plugin publishes `todo_read` and `todo_write`, discovered through
tool search. Tools and the composer checklist share plugin-scoped storage.
Writes replace the whole list using revision checks; concurrent changes are rejected.
Each Session holds up to 200 items of 200 characters each. Completion is reported
by the model, not verified execution evidence. Disabling the plugin withdraws its
tools and UI without deleting the checklist; re-enabling or restarting restores it.

## Session references

Desktop can attach a previewed, committed text snapshot from another Session on the same Host.
Quotes preserve the source name, capture time and truncation marker through storage and model history.
They are immutable excerpts, not live links or authorization to read the source.

Branch and revision history freezes inherited archive references. Each Session can prune
remaining inherited tool results and compact its own context without changing its source,
siblings or earlier frozen reads. A subsequent copy adopts the parent's current projection;
archive verification always retains the original tool-call evidence.

Session removal commits its revision-family plan, admission fence and queued-message
cancellations atomically. Dependent Sessions are archived, not destroyed; restoring one
after cleanup is not undone by an old removal retry. `session.remove.query` recovers the
accepted receipt even after the catalog entry disappears. Public Rust/JS execution
capabilities expose the same removal, preview and receipt semantics, requiring authority
over every directly removed member; history access alone is insufficient.

Host drains accepted executions and processes before reclaiming owned worktrees, and
keeps a shared checkout until its last owner retires. Unproven process cleanup leaves
the workspace intact without blocking unrelated Sessions. Once no surviving history owner
needs a removed Session, background batches release its event bodies, tool payloads and
unshared request surfaces. Original body digests, accounting and terminal proof, identities
and accepted receipts remain. Inherited archive/checkpoint proofs stay pinned transitively;
collected bodies cannot be replayed. Incremental vacuum returns unused pages in bounded
steps; removal is not secure erasure of database/WAL backups.

## Historical imports

Historical imports use the public Rust/JS execution contract under root-creation
authorization. Host stages immutable records and atomically publishes a Session
only after current permission checks. Exact retries survive restart; abandonment
releases unpublished material. Imports participate in transcript, history copies
and compaction, not local execution or accounting. Canonical input is bounded to
7,500 records / 6 MiB so the new Session can continue within the runtime history
budget. Desktop labels these messages as imported history, without inferring local
completion or duration. Tool calls and results retain their separate source
positions; missing results stay unknown. Source adapters and the Desktop import
flow are not yet available.

## Conversation recall

`maka.recall` publishes lazy `Recall`, `RecallMore` and `RecallMaterial` through public history
capabilities. Recall searches complete text in the 200 Sessions with the most recent
messages, including archives, using Unicode-normalized literal terms and BM25 ranking.
It excludes the current Turn and reports unread sources and clipped passages.
RecallMore expands neighboring messages or resumes a long anchor by UTF-8 offset.
Attachment names are searchable. `RecallMaterial` copies a user upload into the calling
Session before reading it; retries reuse the immutable copy, independently of later source
deletion. Text uses bounded Read pages and continuations; images retain their visual content.
Unsupported binary formats fail explicitly. Incognito mode withdraws all three tools.
Historical statements are not verified facts.

Desktop conversation search calls the plugin's public `search` Remote endpoint instead
of downloading transcripts. Results retain Host identity and canonical message positions;
incomplete scans are explicit, and cancellation or renderer exit closes the owned request.

Host supplies bounded text pages under a fixed log fence; sorting and passage assembly
belong to the plugin. A SQLx-managed, rebuildable text projection avoids repeatedly
parsing large JSON results. The same Rust/JS history API is available to other plugins.
`history.copyMaterial` independently checks source history access and the destination's
Host-issued execution capability; attachment identifiers alone never grant either.

## Code layout

All crates are in `crates/`; directory names describe their responsibilities.

| Boundary | Crates |
| --- | --- |
| Facts and persistence | `runtime`, `event-log`, `presentation`, `config` |
| Execution | `agent`, `model`, `js-runtime`, `tools`, `fs-tools`, `process`, `apply-patch`, `skills` |
| Plugin lifecycle and tool catalogues | `plugins`, `tool-catalog` |
| Client and host | `protocol`, `transport`, `client-capability`, `network`, `runtime-host` |
| Executable | `cli` |

The runtime core has no V8 or SQLite dependency. SQLx migrations own persistent
schema changes. Client Capability registration and reverse-call ownership live in
`client-capability`; the host composes them with execution.

Client capabilities have a connection-wide slot and bounded per-Session slots.
Session publications contain only path-independent Session-affinity tools; frozen
bindings retain their publication scope across reconnects. Archiving a Session
retires all its publication generations and rejects later registration until reopened.
MCP admission derives an exact tool grant from a trusted, frozen publication;
declaring MCP admission does not grant provider trust.

## Development

`node scripts/rust/release-cli.mjs --source <source.tar.gz> --keys <KEYS>
--target <target> --validator <local-maka> --notices <reviewed-notices>
--build-id <identifier> --output <directory>` verifies the source archive and its adjacent checksum/signature,
installs locked npm dependencies with the repository patches, then builds and packs
the native CLI. The Cargo workspace and `maka --version` retain the source version.
npm uses `<source-version>-rust-preview.<identifier>`, e.g. `0.2.0-rust-preview.20260916.1`.
Use the same identifier for all platforms of one build and a new identifier for each
publication; CI may use `<run-id>.<attempt>`. Identifiers follow SemVer prerelease rules.
`makaSource` records the source archive name, source version and SHA-512.
This is traceability, not a signed build attestation.
Omit `--keys` only for unsigned local candidates. Native builds validate `--version` and V8 execution;
`--validator` is only required for cross-target packaging. Notices default to the source's Rust inventory.
The `Native CLI preview` workflow builds all three platforms from one frozen source archive.
`node scripts/rust/publish-cli.mjs <artifact-directory>` validates their common provenance;
`--publish` publishes the complete verified set to `rust-preview` (CI supplies npm provenance).
`CARGO_TARGET_DIR` may retain build caches,
but `MAKA_JS_DEPS` is fixed to the extracted source's own install.

`node scripts/rust/pack-cli.mjs --target <target> --version <exact-version>
--binary <target-maka> --validator <local-maka> --notices <reviewed-notices>
--output <directory>` packs prebuilt native code and verifies the resulting npm
archive using the local CLI. It never executes foreign-target code, runs install
scripts, publishes, or overwrites an existing output. Notices must cover Rust,
V8 and embedded JavaScript; legacy Node CLI notices alone are insufficient.
This lower-level packer alone does not establish source provenance.

Rust license checks follow [OpenDAL's cargo-deny approach](https://github.com/apache/opendal/blob/main/scripts/dependencies.py):
`deny.toml` defines the five distribution targets, permitted licenses and version-specific MPL exceptions.
With cargo-deny 0.20.2 installed, run `node scripts/rust/dependencies.mjs check`;
after dependency changes, run the same command with `generate` and review
[`DEPENDENCIES.rust.tsv`](../crates/cli/DEPENDENCIES.rust.tsv).
The inventory includes build dependencies but excludes dev-only dependencies;
the policy check also covers tests. It is not a binary license-text bundle.

The ASF voting artifact is the source archive. Its licensing review covers bundled
source, including the adapted Codex patch code and copied Deno telemetry files
documented in root `LICENSE` and `NOTICE`; lockfile references are not bundled code.
npm native packages are convenience builds of the corresponding source archive,
not a separate source release. Keep their source version and build provenance;
the current source audit does not certify binary licensing.

Source verification rejects SQLite database bytes, regardless of filename or inventory entry.
Historical database fixtures ship as SQL and are reconstructed only during tests.

```sh
cargo fmt --all --check
cargo nextest run --locked --workspace -j 4
cargo test --locked --workspace --doc
cargo clippy --locked --workspace --all-targets -- -D warnings
node scripts/asf-license-headers.mjs check
```

Use `name.rs` with a `name/` directory for child modules. Unit tests belong at
the end of source modules; integration tests belong in `tests/`.
Prefer structs and enums for domain contracts; derive their schemas with
schemars. Reserve JSON values for genuinely open payloads and dynamic schemas.
SQLx migrations own tables and indexes; startup only rebuilds derived data.
Shared cross-language fixtures live in root `tests/fixtures` and use
`tests/support/source.mjs` to load current TypeScript sources, never workspace `dist`.
Grep differential tests require `rg` on PATH; the runtime itself does not.
V8-dependent suites share a test binary per crate to avoid repeated
linking. Ordinary tests use local fixtures; real-provider tests require explicit
opt-in. The ignored `original_client_live_provider` test accepts `MAKA_LIVE_PROTOCOL`
(`chat`, `responses`, `messages`), `MAKA_LIVE_BASE_URL`, `MAKA_LIVE_MODEL`, and
`MAKA_LIVE_API_KEY`; its default is the development SGLang endpoint.
An isolated worktree can set `MAKA_JS_DEPS` and
`NODE_PATH` to the dependency-bearing checkout and its `node_modules`.

## Current limits

Project management, basic Session/Turn control, model configuration, attachments, file tools, shell/PTY,
Client Capability tools, model streaming and context compaction are implemented.
Codex subscription execution is supported; Copilot/xAI inference adaptation and
live verification are deferred.

WorkHub supports scoped conversation, candidate discovery, interactive target selection,
delegation to existing or new sessions, steering, stop, resume and correction.
Its delegated-model panel can repair a failed creation or change an existing target's model.
Selections use current caller authorization and configuration CAS; the original delegation,
root identity and execution receipts remain unchanged. Retry after a concurrent or busy response.
Control actions follow the exact delegated Message, never an unrelated Run.
Correction records intent before retirement, then atomically commits the replacement,
attachments and queued delivery. Recovery can finish after the coordinator Run ends;
unavailable replacements produce durable aborts. Shared Runs are not cancelled.
Canonical records preserve original creation choices and attachment ownership;
candidate queries expose the latest active association, including waiting and blocked work.
Discovery does not authorize delegation; admission rechecks interactions and unsettled effects.
Pending interactions drive the shared Session catalog and its change notifications,
so WorkHub's “Needs you” view agrees with candidate discovery and clears after resolution.

Remaining functionality and the whole-domain built-in plugin migration plan are maintained in
[Rust parity and built-in plugins](rust-parity.md), including SDK and client integration gaps.

Recall is conversation-history retrieval, not the excluded Memory subsystem.
Native deployment and updates do not imply full product compatibility.
The plugin platform supports linked Rust packages, shared/dedicated-V8 JavaScript packages,
scoped Host services, external executors, and Desktop Slots/Remote streams.
Graph/Swarm and scheduling are built-in plugins. Graph implementation workers use
Host-owned gix worktrees and publish immutable patches without automatic merging.
`agent_list` returns ready-to-use `target` values for Graph work. Agent targets inherit
the parent backend, presets select their configured model, and executor targets select
a plugin backend without native tool-profile constraints.
Per-Turn orchestration survives yield and resume without changing Session defaults;
Swarm checkpoints carry status and final-result IDs, with paged history for retrieval.
See the [plugin SDK](../packages/plugin-sdk/README.md) for contracts and limits.
OS sandboxing is deferred. Memory is excluded pending a separate redesign;
its existing implementation is not ported. Content redaction is omitted.
