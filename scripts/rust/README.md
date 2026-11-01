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

Terminal behavior uses the [terminal-shell tests](../../products/maka/terminal-shell/tests/real_host/mod.rs). Run them with `cargo nextest run -p maka-cli --test integration -E 'test(terminal::)'`. These cover current component and product interactions; compare release rendering separately with a fixed terminal protocol, viewport and workload.

For long-history performance, build the retained [Engine fixture](../../plugins/agent/engine/tests/integration/long_task_perf.rs) in release mode and compare identical fixture sources and dependency features:

```sh
cargo test --release -p maka-agent-engine --test integration --no-run
python3 scripts/rust/benchmark-long-task.py \
  --baseline /tmp/engine-before --candidate /tmp/engine-after \
  --sizes 250,1000 --runs 5 --output /tmp/maka-long-task
```

`--checkpoint` measures requests after actual context compaction. The script alternates revisions, verifies equal completed work, and retains raw samples, medians and ranges. Fixture setup is excluded from request/completion timings. This measures Engine APIs and the controlled HTTP provider, not Host IPC, rendering, inference or energy.

For larger histories, set `MAKA_ENGINE_PERF_FIXTURE_DIR` to a disposable directory and `MAKA_ENGINE_PERF_FIXTURE_TAG` to a revision label. Closed snapshots are keyed by workload settings and fixture source; preserve both when comparing retained executables. Seeding is separate from request latency and may take much longer. Run without competing builds and collect CPU profiles separately.

## CI

The [suite catalog](../ci/suites.mjs) defines maintained build and test scopes. `just` and the [workflow](../../.github/workflows/ci.yml) use the same [executor](../ci.mjs). Inspect committed changes or reproduce a suite after `just setup`:

```sh
node scripts/ci.mjs plan --base origin/rust-preview
node scripts/ci.mjs run bridge
```

PR plans follow Cargo reverse dependencies and declared runtime inputs; shared or unclassified changes select the full maintained set. Branch pushes and manual runs select the full set. Package filtering preserves each suite's workspace/features build recipe. The GPUI suite covers selected headless platform and terminal tests; standalone host webview/video configurations are outside that scope.

The root producer creates a nextest archive, including runtime product assets. Test workers execute partitions of that same artifact; the final `test` check requires all selected work to succeed. Cargo caches accelerate builds and are not test artifacts.

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
