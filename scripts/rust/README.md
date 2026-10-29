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

# Native build tooling

[简体中文](README.zh-CN.md)

These scripts build source-bound native packages and their npm launcher. The public command sequence is in [packages/cli](../../packages/cli/README.md).

Native macOS packaging requires Xcode 26 or newer. Linux needs GLib, X11/XCB, xkbcommon, Wayland, Fontconfig and FreeType development files, plus cargo-zigbuild and Zig. The [native CI workflow](../../.github/workflows/npm-publication.yml) records the build environment.

Rust builds require libclang to generate SQLite preupdate-hook bindings, including when a cached V8 bundle is available.

Release packages use pinned V8 builds with optional LGPL glibc math disabled. Completed libraries, bindings and notices are cached in `target/v8`, or `$CARGO_TARGET_DIR/v8`. On a miss, the builder downloads the bundle named by [v8-prebuilts.json](v8-prebuilts.json) and checks its digest. A corrupt cache or broken pin fails explicitly. An absent pin triggers a source build, which also needs Python, Git, Clang/libclang 19 or newer, a C++ toolchain, substantial disk space and time.

A cache key identifies the V8 source, target, features and producer code. For a new key, use the exact archives emitted by a completed native workflow. Publish them as versioned dependency prerelease assets, then record their URLs, hashes and validation evidence in the manifest. Preserve existing assets and key meanings. Native link and smoke checks still run for each package.

After dependency changes:

```sh
node scripts/rust/dependencies.mjs generate
node scripts/rust/notices.mjs generate
node scripts/rust/dependencies.mjs check
node scripts/rust/notices.mjs check
```

Review the generated inventory and license texts. [notices-sources.json](notices-sources.json) records reviewed upstream exceptions. Release assembly also includes notices from the actual V8 build and Rust standard library. The TSV inventory does not replace full license texts.

For offline comparisons of the production Rust and TypeScript Hosts on Linux,
use [host-comparison](host-comparison/README.md). It drives real public clients
against a loopback SSE fixture, verifies canonical output, and retains per-process
and system telemetry. Background-agent capacity probes distinguish requested
sessions, actual active executions, confirmed completions and unknown outcomes.

Terminal behavior uses the current [terminal-shell real Host tests](../../products/maka/terminal-shell/tests/real_host.rs), including the production PTY lifecycle. Run them through `cargo test -p maka-cli --no-default-features --test terminal_real_host`. Compare retained release artifacts with the same renderer, terminal protocol, viewport and workload; report input latency separately from frame encoding and output delivery.

Long-task comparisons use retained release test executables from both revisions,
with the same benchmark fixtures. Build `maka-event-log --test archive` and
`maka-agent-engine --test integration` using `cargo test --release --no-run`, then run:

```sh
python3 scripts/rust/benchmark-long-task.py --kind engine \
  --baseline /tmp/engine-before --candidate /tmp/engine-after \
  --sizes 250,1000 --runs 5 --output /tmp/maka-long-task
```

Use `--kind prune` for the archive test executables and `--checkpoint` for an
Engine run after real context compaction. The script alternates revisions and
checks equal completed work, preserving raw logs, errors, medians and ranges.
Record the target and dependency features as well as the build profile. Feature
unification can make standalone tests use a different hashing backend from a
product build. Older `sha2` 0.10 Engine baselines on supported ARM64 platforms
need `--features sha2/asm` to match the product backend. Current hashing selects
supported CPU instructions at runtime and retains a software fallback.

Fixture setup is excluded; Engine timings cover request delivery and completion,
not Host IPC. The [Engine fixture](../../plugins/agent/engine/tests/integration/long_task_perf.rs)
and [prune fixture](../../platform/event-log/tests/archive/performance.rs) expose
workload settings for sparse tools, dense tools and projection sizes. Run without
competing builds; collect CPU profiles separately from timing comparisons.

For 1,000 / 10,000 / 100,000-turn scale probes, set `MAKA_ENGINE_PERF_FIXTURE_DIR`
to a disposable directory under the system temporary directory and
`MAKA_ENGINE_PERF_FIXTURE_TAG` to an explicit revision label. The Engine fixture
uses real append validation and compacts every 1,000 turns. It caches closed
SQLite snapshots using all workload settings and a hash of its own source;
changing the fixture invalidates the cache. Run `--kind engine --checkpoint
--sizes 1000,10000,100000` against retained executables with identical fixture
source. Seeding is deliberately separate from request latency and can take much
longer than the measured run.

For history and cancellation, set `MAKA_RESPONSIVENESS_FIXTURES` to a
comma-separated list of those disposable `.sqlite` snapshots and use
`--kind responsive`. This checks a real bounded history
page and cancellation before admission, 10 ms after admission, and after model
HTTP receipt. `long_history_window` measures the direct first page after opening
the copied store; initial directory installation during that open is excluded and
must be measured separately. Retained `long_history_preparation` records describe
the earlier prepare-then-read probe and keep their original meaning. Before-admission cases cover ordinary and manual-message preflight:
start must remain pending at the 10 ms stimulus, then cancel without an opening
or model request. Use a sufficiently large fixture; early admission fails the probe.
The after-admission trigger does not guarantee preparation is still running;
inspect the model request count. Stop timing ends when start returns cancellation
or the admitted Engine completes cleanup with a durable cancelled outcome. It
excludes closing the EventLog and draining abandoned read snapshots.
It measures the store/Engine APIs, not GUI or
Host IPC latency. Context/prune reads interrupt abandoned SQLite work through a
progress handler and await transaction cleanup before reuse. Separate behavior
tests cover reclaiming both readers and transaction recovery; arbitrary
synchronous Rust computation is not immediately interruptible.

`--kind transcript --sizes 128,512` uses retained release
`maka-event-log --test transcript_index` executables to check many model steps
inside one invocation. It verifies every assistant message from each
fresh copy; this workload complements many-turn Engine fixtures.

`--kind executor --sizes 128,512` uses the same transcript executable for
sequential external tools. It compares every persisted message with canonical
replay, including progress, results, and final invocation state.

For repeated compression in one live Host session, retain the release
`maka-agent-native --lib` test executable and run:

```sh
MAKA_COMPACTION_CYCLES=10 MAKA_COMPACTION_PROMPT_BYTES=65536 \
  "$NATIVE" owner::tests::scale::compaction::real_host_same_session_compaction \
  --ignored --exact --nocapture --test-threads=1
```

Each cycle sends new input and performs a real manual compaction through Host
receipts. A final request verifies adoption of the latest checkpoint; paginated
history verifies the original messages. The `MAKA_AGENT_COMPACTION` JSON reports
actual requests/checkpoints, verified bytes and per-operation latency/CPU.
Operation timings exclude setup, evidence reads and shutdown, but include the
in-process controlled HTTP model. Request JSON sizes are normalized serialization
sizes; peak RSS covers the whole process. This probe uses four Tokio workers and
does not measure IPC, rendering, automatic compaction, inference or energy.

For actual Executor attachment capture, use the same release native test executable:

```sh
MAKA_ARTIFACT_PROBE_BYTES=51847623 \
  "$NATIVE" owner::tests::executor::executor_attachments_use_only_owned_immutable_uploads_and_original_receipts \
  --exact --nocapture --test-threads=1
```

The setting changes the first uploaded file; sixteen smaller files retain order,
byte/digest, authority and original-operation replay checks. `MAKA_ARTIFACT_PROBE`
reports actual work, SQLite version, observed completion latency/CPU and cleanup.
Stage timings exclude upload but include Host preparation, synchronous service
reads/hash and observation; the service-entry observation can include the entire
service call. Peak RSS includes the driver. Compare identical fixtures/features
with at least five alternating runs per size and profile separately; this is not
an isolated SQLite, IPC, rendering, inference or energy measurement.

For actual service-tool execution on Unix, use the same release native test executable,
with one case per process:

```sh
MAKA_TOOL_STORM_CALLS=64 MAKA_TOOL_STORM_PAYLOAD_BYTES=128 \
  MAKA_TOOL_STORM_BACKEND=native \
  "$NATIVE" owner::tests::service_tools::storm::real_service_tool_storm \
  --ignored --exact --nocapture --test-threads=1
```

This case executes sequential mutations. Use `real_service_query_fanout` in the
same module for read-only calls in one model step, or backend `javascript` for
the actual JavaScript service. Fanout count does not imply simultaneous handlers.
The `MAKA_AGENT_TOOL_STORM` JSON records actual calls, exact result checks,
requests, latency/CPU, process peak RSS and cleanup. Timings include the controlled
HTTP responder; they exclude external inference, IPC and rendering. Large
payloads can trigger real automatic compaction. The responder supplies Summary
text and verifies the resulting checkpoint and its adoption by the next Main,
while history checks retain every original tool result. Summary requests and
checkpoints are reported separately from tool work. This proves the controlled
protocol and lifecycle, not a real model's context capacity or summary quality.
Only completed, fully verified work counts as a successful case.

For real image uploads on Unix, use the same release native test executable:

```sh
MAKA_IMAGE_COUNT=2 MAKA_IMAGE_SIDE=512 \
  "$NATIVE" owner::tests::scale::image_upload::real_image_upload_vision_scale \
  --ignored --exact --nocapture --test-threads=1
```

Choose `MAKA_IMAGE_PROTOCOL=openai-compatible` (default), `openai-chat-completions`,
`anthropic`, or `responses` to exercise the actual protocol. Compatible requests
with `MAKA_IMAGE_RETRY=true` receive one explicit `stream_options` rejection;
both HTTP attempts must contain every original image.

Each process generates distinct valid RGBA PNGs, fully decodes them for validation,
then uploads sequential file snapshots through the Host. The probe checks durable
upload receipts, original artifact bytes and canonical references, exact ordered
images in the actual provider HTTP request, complete public history and cleanup.
Only exact image delivery passes: an accepted upload or completed answer with a
text replacement does not. `MAKA_AGENT_IMAGE_SCALE` records actual encoded sizes,
pixel dimensions, stage timings, process peak RSS and failure evidence. Generation
and validation are reported separately from upload and turn timing; their memory
still contributes to process peak RSS. The HTTP responder and checks run in the
same process. This does not measure product pixel decoding, IPC, rendering, real
model inference or energy. Expand image count and dimensions independently, and
preserve failing cases when an existing boundary prevents exact delivery.

## Windows State Root ownership

New State Root directories are created with an explicit current-account owner and a private ACL. An elevated Windows token can otherwise default the owner to the Administrators group. Existing directories retain their permissions until Root validation; nonempty, unrecognized directories are not adopted.

Older TypeScript and Rust installations share `%LOCALAPPDATA%\Maka\state-root-owners` and `%LOCALAPPDATA%\Maka\runtime-hosts`. If an existing directory is owned by Administrators, startup reports its path and the actual/expected owner SIDs. The program deliberately does not take ownership automatically.

For a directory you recognize as your own Maka state, stop all local TypeScript and Rust Hosts before recovery. Review the path from the error and its contents, then use an elevated PowerShell to back up its security descriptor and change only that directory's owner to the current account:

```powershell
$path = 'C:\Users\YOUR_ACCOUNT\AppData\Local\Maka\state-root-owners'
$acl = Get-Acl -LiteralPath $path
$acl | Format-List Owner,AccessToString
if ($acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne 'S-1-5-32-544') {
    throw 'This recovery step is only for a reviewed Administrators-owned directory.'
}
$backup = [System.IO.Path]::GetTempFileName()
$acl.Sddl | Set-Content -LiteralPath $backup
$acl.SetOwner([System.Security.Principal.WindowsIdentity]::GetCurrent().User)
Set-Acl -LiteralPath $path -AclObject $acl
Write-Output "Previous security descriptor: $backup"
```

Retry startup; it will validate the directory and restrict access to the current account and SYSTEM. Review each subsequent reported directory separately, including an empty Root left by an earlier failed startup. Keep the backup until startup succeeds. Do not delete or replace lock files, recursively take ownership of state, or change the owner of an unrecognized directory.
