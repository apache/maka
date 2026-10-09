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

# Development Runtime Host

How to run a real Maka Runtime Host for this client during development, and
how the client finds it. Source references point into the Maka checkout at
`$MAKA_REPO` (default `~/code/maka-pin`).

The client speaks the protocol of one apache/maka commit, named in `MAKA_PIN`
with its compatibility epoch. A Host from any other commit may refuse the
handshake (`incompatible`) or send shapes this client does not model, so the
checkout must be at that commit. `~/code/maka-pin` is a detached checkout kept
there; to create or move it:

```sh
git clone https://github.com/apache/maka.git ~/code/maka-pin   # once
git -C ~/code/maka-pin checkout --detach "$(sed -n 's/^commit=//p' MAKA_PIN)"
```

then install the dependencies that commit locks (`npm ci` in the checkout,
after nvm, as in Maka's README) and build it (Prerequisites). The app shows
these commands itself when it finds no built checkout or a Host of another
epoch (see "When no attempt can succeed").
`scripts/check-protocol-drift.sh` (`just drift`) fails when the checkout's
commit or epoch differs from `MAKA_PIN`.

Always use a dedicated dev State Root. Never point the Host, the examples, or
the fixture capture at your live Maka data.

## Prerequisites

- A Maka checkout at `$MAKA_REPO`, at the commit `MAKA_PIN` names.
- Node 24.18 through nvm. The Maka repository's local tooling is known to
  misbehave on Node 22.17.
- Built `dist/` output for the CLI and the packages it loads. The full
  `npm run build` also builds the Electron app; the Host needs only this
  chain:

  ```sh
  cd "${MAKA_REPO:-$HOME/code/maka-pin}"
  source ~/.nvm/nvm.sh && nvm use 24.18
  npm --workspace maka-agent run build:workspace-deps   # core, storage, mcp, runtime, runtime-host, eval
  npm --workspace maka-agent run build                  # packages/cli
  ```

  `npm run check:stale` lists packages whose `src` is newer than `dist`.
  Entries for `@maka/ui` and `@maka/desktop` do not matter for the Host.

## Start

```sh
cd "${MAKA_REPO:-$HOME/code/maka-pin}"
source ~/.nvm/nvm.sh && nvm use 24.18
node packages/cli/dist/dev-cli.js runtime-host serve \
  --root "$HOME/code/maka-gpui/.dev-root" --json
```

`.dev-root/` is gitignored. The first start creates the State Root there.
With `--json` the Host prints one ready line and then stays in the
foreground:

```json
{"schemaVersion":1,"event":"runtime_host_ready","rootId":"67d4…fb8d","hostEpoch":"9c0a…b912",
 "protocol":{"version":0,"compatibilityEpoch":197},"composition":{"id":"maka.interactive","revision":"3"},
 "listeners":[{"kind":"local_ipc","endpoint":"/var/folders/…/T/m-501-…/h.sock"}]}
```

`runtime-host serve` always publishes a local IPC listener; WebSocket is only
added with `--websocket-port`. The registration it writes has
`lifecycleMode: "service"`, so the Host does not exit when idle. `just run`
passes `--root .dev-root`, so the app connects to this Host and never starts
one of its own while it runs. A Host the app starts itself is different; see
the next section.

Only one Host can own a State Root at a time (an owner lock, see below). A
second `serve` for the same root fails.

## How the app starts a Host

When no Host answers for its State Root, the app starts one, the way the TS
CLI and Maka Desktop do (`host_client::connect_or_spawn`, mirroring
`packages/runtime-host/src/client/connect-or-spawn.ts` and `launcher.ts`):

1. It prepares the State Root like `resolveStorageRoot` in
   `packages/storage/src/root-authority.ts`: creates the directory (mode 0700)
   and, if missing, `.maka-storage-root.json` (mode 0600) with a fresh
   `rootId`. An existing marker is only read and checked against the
   directory's device and inode; a copied root is refused.
2. It reads `registration.json` and connects. A registration that exists and
   answers is used as is; that is why the running dev Host above is never
   duplicated.
3. Otherwise it spawns a candidate, detached from the app (its own process
   group) with stderr piped and `MAKA_RUNTIME_HOST_STDERR_PIPE=1`:

   ```sh
   <node> $MAKA_REPO/packages/runtime-host/dist/execution-candidate-main.js \
     --root <canonical State Root> --expected-root-id <rootId> \
     --startup-attempt-id <uuid v4> --initial-connection-timeout-ms <ms left>
   ```

   and polls the registration (20 ms doubling to 250 ms) until the Host
   accepts a connection, for up to 75 s. A candidate that lost the owner
   lock to another launcher exits with 2 and another is tried; one that
   exits with a startup failure code (65, 70, 77, 78, 80–87,
   `packages/runtime-host/src/candidate-startup-failure.ts`) is reported
   with the text of its `startup-diagnostic.<attempt>.json`, which is then
   kept as `startup-diagnostic.json` until a later connection succeeds and
   deletes it, together with the diagnostics of that election's own failed
   candidates (as `connect-or-spawn.ts` does).

While this runs, the strip above the conversation says "Starting Maka…".
A failure replaces it with the reason and Retry; the serve command stays
below as the manual fallback. The supervisor runs the same election on
every reconnect, so a Host that crashed or idled out comes back by itself.

The spawned Host is `ephemeral`: it exits by itself once no client has been
connected for its idle grace (30 s by default), and its initial connection
timeout covers a launcher that never connects. The app does nothing about it
on quit.

What it needs, and where it looks:

- The Maka checkout: `$MAKA_REPO`, default `~/code/maka-pin`, with
  `packages/runtime-host/dist` built (`build:workspace-deps` above). A set
  `MAKA_REPO` without a build is an error; the default is not tried then.
  Either way the window says which path it looked at and how to build it
  (next section). A released Maka CLI package is the next source to add.
- Node 22.19 or newer (`engines` in Maka's `package.json`): `$MAKA_NODE` if
  set (it must qualify), else the first `node` on `PATH` if it is new enough,
  else the newest qualifying version under `$NVM_DIR/versions/node` (default
  `~/.nvm`). An app started from Finder has no nvm on its `PATH`, so the nvm
  step is what usually finds Node. On this machine `node` on `PATH` is nvm's
  22.17, which is too old, and the app picks nvm's newest (26.5); set
  `MAKA_NODE=~/.nvm/versions/node/v24.18.0/bin/node` to pin the version this
  document uses.
- `MAKA_RUNTIME_HOST_ELECTION_DEADLINE_MS` (1–120000) replaces the 75 s
  deadline and `MAKA_RUNTIME_HOST_IDLE_GRACE_MS` (0–120000) sets
  `--idle-grace-ms`, as in the TS launcher. An invalid value is an error, not
  ignored.
- The candidate inherits the app's environment, so the provider keys below
  apply to a State Root it creates.

The launcher is tested against a fake candidate
(`crates/host-client/tests/fixtures/fake-candidate.sh`). An ignored test runs
the real one on a scratch root under `target/tmp`, waits for `ready`, calls
`host.status`, and waits for the idle exit:

```sh
MAKA_REPO=~/code/maka-pin cargo test -p host-client --test real_candidate -- --ignored --nocapture
```

## When no attempt can succeed

Two failures stop every attempt until something outside the app changes. For
them the plate shows a screen of its own under the header, in place of the
task view (or a page) and the disconnected strip, with Retry (⌘R) and Switch
data folder…. The supervisor reports them as `ConnectionEvent::Suspended`
with a `HostBlocker` (`crates/host-client/src/blocker.rs`); `HostSession`
keeps it through a retry the user asked for, so the screen does not flicker,
and drops it once an attempt gets further.

- **A Host of another protocol epoch.** A Host refuses any client whose
  compatibility epoch differs from its own and answers `incompatible`
  (`HostKernel#handshake` in `packages/runtime-host/src/server/host-kernel.ts`).
  The screen names both epochs and which side is newer, the commit this
  client was built for (`MAKA_PIN`, embedded when `host-protocol` compiles,
  as `MAKA_PIN_COMMIT`), and the checkout `MAKA_REPO` names, then the
  commands that move that checkout to the pinned commit, reinstall and build
  it. An older Host means the checkout or the Maka CLI that serves the root
  is behind; a newer one means this client is behind, or the checkout moved
  past the pin. The answer's `replacement` says whether that Host exits by
  itself once idle (`wait_for_idle_exit`: an ephemeral Host with nothing in
  flight; a retry after that starts one from the checkout) or stays until it
  is stopped (`blocked_by_residency`: a `serve` Host, or one with work in
  progress; see Stop). A Host whose handshake fails in a way this client
  cannot read counts too when its registration names another epoch
  (`ConnectError::RegisteredEpochMismatch`). An `incompatible` answer at
  this client's own epoch (another composition) keeps the strip.

  The TS election keeps polling on `wait_for_idle_exit` until that Host
  idles out and a candidate can replace it. This client stops at the first
  `incompatible` answer instead: a candidate from the same checkout would
  usually be refused the same way, after up to the whole election deadline.
- **No built checkout.** When no Host answers and `$MAKA_REPO` (default
  `~/code/maka-pin`) has no `packages/runtime-host/dist/execution-candidate-main.js`,
  the screen names the path, says whether `MAKA_REPO` set it, and shows the
  clone commands when nothing is there, or the build commands of
  Prerequisites for a checkout that was not built.

Any other failure that stops the retries (a copied State Root, no Node new
enough, a startup failure) keeps the strip with its reason.

To see the screens, each on a fresh State Root under `target/` (the app
creates it):

```sh
cargo build -p app
# A Host older than this client; --epoch 198 --replacement blocked_by_residency for a newer one.
scripts/incompatible-host.py --root target/epoch-root --epoch 196 &
target/debug/maka-gpui --root "$PWD/target/epoch-root"
kill %1                                   # removes its registration

# No checkout, then a checkout that was not built.
MAKA_REPO=/nonexistent/maka-pin target/debug/maka-gpui --root "$PWD/target/no-checkout-root"
mkdir -p target/empty-checkout
MAKA_REPO="$PWD/target/empty-checkout" target/debug/maka-gpui --root "$PWD/target/no-checkout-root"
```

`scripts/incompatible-host.py` stands in for a Host of another epoch: it
prepares the root, writes a `service` registration for it in the control
namespace, answers every `hello` with `incompatible` at the epoch it is
given, and removes the registration when it stops.

## Choosing the State Root

`--root` sets the State Root for one launch. Without it the app opens the
root chosen at an earlier launch, remembered in
`~/Library/Application Support/maka-gpui/state-root.json`. On the first
launch it asks, proposing `~/Library/Application Support/maka-gpui/state-root`;
Maka Desktop's data directory (`~/Library/Application Support/Maka`, whose
`workspaces/default` is its live State Root) is never proposed and is refused
as a choice. Host > Switch Data Folder… asks again and reopens the window on
the new root. Delete `state-root.json` to see the first-launch dialog again.

### Provider keys in the environment

On its first start with an empty connection catalog, the Host imports one
provider key from the environment into the State Root: `DEEPSEEK_API_KEY`,
else `ANTHROPIC_API_KEY`, else `OPENAI_API_KEY`
(`ensureBootstrapRuntimePolicy` in
`packages/runtime-host/src/server/bootstrap-runtime-policy.ts`). The key is
stored in `.dev-root/credential-vault.json` and appears as an `env-*`
connection. That is useful for Phase 1, which needs a working model, and it is
why `.dev-root/` must never be committed. To start without a key, prefix the
command with `env -u DEEPSEEK_API_KEY -u ANTHROPIC_API_KEY -u OPENAI_API_KEY`.

## Check it from Rust

```sh
cargo run -p host-client --example status -- --root .dev-root
```

It discovers the registration, completes the handshake, waits for
`state: ready`, calls `host.status` and pages through `session.catalog.query`,
then shuts the connection down and exits 0.

## Stop

Press Ctrl-C in the Host's terminal, or send SIGTERM to its pid (the `pid`
field of `registration.json`). The Host handles SIGINT and SIGTERM
(`runRuntimeHostProcessLifecycle` in
`packages/runtime-host/src/server/process-lifecycle.ts`), closes its
connections, and removes its registration.

```sh
kill "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["pid"])' \
  "$HOME/Library/Caches/Maka/runtime-hosts/<rootId>/registration.json")"
```

## Windows

Nothing in this section has been run on Windows. CI checks that the
workspace compiles for `x86_64-pc-windows-msvc`; on macOS it also compiles
and links for `x86_64-pc-windows-gnu`; the endpoint parser is unit-tested on
every platform.

- Transport: the Host listens on a named pipe,
  `\\.\pipe\maka-runtime-host-<first 16 characters of rootId>-<hostEpoch>`,
  restricted to the current user and SYSTEM (`prepareRuntimeHostEndpoint` in
  `packages/runtime-host/src/control/endpoint.ts`), and `registration.json`
  names it. `Connection::connect` opens it with the same framing as the Unix
  socket (`crates/host-client/src/named_pipe.rs`): with
  `SECURITY_IDENTIFICATION`, so the Host cannot impersonate the client,
  retrying while the pipe is busy, and refusing a pipe on another machine
  (`LocalEndpoint::parse`). The two halves run on the `blocking` pool with
  overlapped I/O from the `interprocess` crate, because a handle opened for
  synchronous I/O would hold every write behind a waiting read. A named pipe
  has no half-close, so closing the connection sends one last `host.status`
  request; the Host's answer ends the pending read and the handle closes.
- State Root: `prepare_state_root` returns `Unsupported`. The marker's
  `rootIdentity` is the volume serial number and file index that Node's
  `stat` reports, which stable Rust does not expose (`windows_by_handle`)
  and this workspace cannot read without `unsafe`. The app always connects
  through `RootConnector::spawning`, so on Windows it stops there, even when
  a Host is running. `RootConnector::new` and the `status` example connect
  to a running Host (`runtime-host serve --root <root>` as in Start above).
- Spawning, once a root can be prepared: the candidate gets the creation
  flags libuv uses for a detached, hidden spawn (`DETACHED_PROCESS`,
  `CREATE_NEW_PROCESS_GROUP`, `CREATE_NO_WINDOW`), so it has no console and
  no Ctrl-C reaches it. Node comes from `MAKA_NODE`, then `node.exe` on
  `PATH`, then `$NVM_DIR\versions\node\v*\bin\node.exe` (default
  `~\.nvm`); nvm-windows keeps its versions elsewhere
  (`%NVM_HOME%\v<version>\node.exe`) and is not searched.
  `--idle-grace-ms` and the election deadline come from the same environment
  variables as on macOS. A candidate that dies has no signal to report.

## Where things are

| What | Path (macOS) | Source |
|---|---|---|
| Root marker, holds `rootId` | `.dev-root/.maka-storage-root.json` | `STORAGE_ROOT_MARKER_FILE`, `isRootMarker` in `packages/storage/src/root-authority.ts` |
| Control directory | `~/Library/Caches/Maka/runtime-hosts/<rootId>/` | `resolveRootControlNamespace` in `root-authority.ts` |
| Registration | `<control directory>/registration.json` | `readHostRegistration` in `packages/runtime-host/src/control/registration.ts` |
| Owner lock | `~/Library/Application Support/Maka/state-root-owners/<rootId>.lock` | `resolveRootOwnershipNamespace` in `root-authority.ts` |
| Socket | `/var/folders/…/T/m-<uid>-…/h.sock`, from `registration.endpoint` | `packages/runtime-host/src/control/endpoint.ts` |
| Startup diagnostic of a failed candidate | `<control directory>/startup-diagnostic.<startupAttemptId>.json`; the one that ended an election, `startup-diagnostic.json` | `resolveCandidateStartupDiagnosticPath` in `packages/runtime-host/src/control/startup-diagnostic.ts` |
| Remembered State Root | `~/Library/Application Support/maka-gpui/state-root.json` | `workspace::StateRootFile` |

The registration lives in the cache namespace, not in `state-root-owners/`;
that directory holds only the owner lock files. On Linux the control namespace
is `~/.cache/maka/runtime-hosts`, on Windows `~\AppData\Local\Maka\runtime-hosts`.
`host_client::discover_host` implements marker → `rootId` → control directory
→ registration.

## Golden fixtures

`--sequences` records Turn scenarios into
`crates/host-protocol/fixtures/sequences/<name>.jsonl` (one frame per line, both
directions). The `plain_text`, `permission_allow` and `stop_mid_stream`
scenarios need a working LLM connection in the dev root; the tool refuses to
write a file when the Turn outcome does not match the scenario. `--only` limits
the run to named scenarios.

With the Host running:

```sh
scripts/capture-fixtures.sh                     # same as `just fixtures`
scripts/capture-fixtures.sh --create-session /private/tmp/maka-gpui-fixture-workspace
scripts/capture-fixtures.sh --sequences /private/tmp/maka-gpui-fixture-workspace   # record Turn scenarios
scripts/capture-fixtures.sh --sequences /private/tmp/maka-gpui-fixture-workspace --only stop_after_start,failed_turn
```

This runs `cargo run -p host-client --example capture_fixtures` and rewrites
`crates/host-protocol/fixtures/*.json`: the registration, the hello this
client sends, `accepted`, an `incompatible` answer to a hello from the previous
epoch, and the `host.status` and `session.catalog.query` responses.
`--create-session` first creates one Session in the given directory (so the
catalog holds a real projection) and also records `session.create`, a
`session.catalog.query` `get`, and the `session.catalog.changed` push. It
adds a new Session every time it runs, so use it only when the fixtures need
one. Set `MAKA_GPUI_DEV_ROOT` to use a root other than `.dev-root`.

The capture tool refuses to write a frame with a credential-looking key.
Fixtures do contain Host epochs, connection ids, and the socket path; those
are random per run and not secret.

Start the Host for a recording with `HOME` set to an empty directory (for
example `HOME=$PWD/target/fixture-home`, after sourcing nvm). The Host adds
every Skill under `~/.agents/skills` and `~/.maka/skills` to each prompt
(`STANDARD_SKILL_LOCATIONS` in `packages/core/src/skill-locations.ts`); with a
personal Skill catalog a small local model follows the Skills instead of the
scenario's prompt, and its replies quote them into the fixtures. The Host
still writes its registration under the real home, where the capture tool
looks. The epoch-197 fixtures were recorded that way on a fresh root,
`target/fixture-root-197`.

## Model connection for real Turns

The Host seeds one connection from `DEEPSEEK_API_KEY`, `ANTHROPIC_API_KEY` or
`OPENAI_API_KEY` on first start (`packages/runtime-host/src/server/bootstrap-runtime-policy.ts`).
If those keys are invalid every Turn ends `failed/auth`. The dev root on this
machine instead uses a local Ollama model:

- connection `ollama-local`, provider `custom` with `defaultApiProtocol`
  `openai-chat` (before epoch 184 the provider was `openai-compatible`; a Host
  at 184 or later reads stored ones as `custom` and persists that on the next
  catalog write), base URL
  `http://127.0.0.1:11434/v1`, api key `ollama`, enabled models `qwen2.5:7b` (default) and `phi4:latest`;
- it is the catalog default target, so `modelTarget: {kind: "default"}` picks it.

It was created through the protocol with `connection.onboarding.verify` and
`connection.onboarding.save`, then `connection.catalog.set-default-target`
(`packages/runtime-host/src/protocol/connection-effects.ts`, `runtime-policy.ts`).
Any client, including the TS one in `@maka/runtime-host/client`, can do the same.
`ollama serve` must be running before a Turn starts. Every Turn carries the
tool catalog, and Ollama rejects the whole request for a model without tool
support (phi4 fails with `request_rejected`), so the default must be a
tool-capable model such as `qwen2.5:7b`. Model and default changes go through
`connection.catalog.update` and `connection.catalog.set-default-target`.

## Why the permission fixture is still missing

In `ask` mode the Host compiles a workspace-write profile
(`packages/core/src/permission-profile-compiler.ts`): tools inside the
workspace and under the temp directory run without a prompt. The prompt real
users see is the `sandbox_boundary` interaction, raised only when the model
calls the `request_sandbox_boundary` tool
(`packages/runtime/src/sandbox-boundary-tool.ts`). qwen2.5:7b either answers in
text or loops on other tools instead of calling it, so
`sequences/permission_allow.jsonl` has not been recorded yet. The capture tool
answers both `permission` and `sandbox_boundary` prompts with allow and bounds
every Turn with `maxSteps`; rerun `--only permission_allow` with a stronger
model when one is available.

Until that recording exists, `crates/host-protocol/fixtures/hand_built/sandbox_boundary_allow.jsonl`
stands in for the sandbox-boundary part: a pending prompt, the client's allow,
the answered snapshot, and the projection after it. It is written by hand from
the TS decoders (`decodeInteractionRequest` and
`decodeInteractionCanonicalOutcome` in `packages/core/src/interaction.ts`,
`validateSandboxBoundaryExpansion` in `packages/core/src/sandbox-boundary.ts`),
uses `hand-built-*` ids, and is not a recording; the capture script never
writes to `hand_built/`. Delete it once a real sequence covers the prompt.
