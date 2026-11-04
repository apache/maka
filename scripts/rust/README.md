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

## OAR worker

The normal CLI build also runs `scripts/oar/build.mjs` from that source checkout,
using the exact OAR and Deno versions in the root lockfile. It bundles OAR as ESM,
compiles a standalone Deno executable, and stages `maka-oar-worker[.exe]` beside
`maka[.exe]`. Native packages require and validate that sibling, including cached
packages. No Node/npm installation or module download is needed at runtime. This
build does not update OAR or install agents.

Development uses the official Deno template. `buildCli({ release: true })` and
`node scripts/oar/build.mjs --release --target TRIPLE --output DIRECTORY` instead
build the pinned Deno source in `scripts/oar/runtime-source.json` against the
controlled V8 archive and bindings (`v8_use_libm_trig_functions=false`).
The existing `buildV8` policy is shared: use a pinned prebuilt when available,
otherwise build reviewed V8 source and notices through `compileV8`. This does not
reduce the five supported release targets.
The independent Cargo target directory also builds Deno's CLI snapshot with that
V8. The fixed Deno CLI consumes this template through `DENORT_BIN`; a missing
controlled template, compilation failure, version/target mismatch or changed
template bytes is fatal, with no official-template fallback. Selection follows the output
target, not the host. `worker-receipt.json` records the source revision, V8 inputs,
denort, bundle and worker hashes. Each invocation bundles current sources; the
worker is reused only when its input digest (bundle bytes, Deno version, compile
target/options and controlled runtime receipt) and executable output hash match.
Missing, changed or non-executable outputs are recompiled. Release still validates
the controlled template before reuse; replacing template bytes at the same path
requires an updated runtime receipt and a new worker.

Official Deno 2.9.6 Linux x64 worker inspection found defined `glibc_sin`,
`glibc_cos` and `__branred` symbols from V8's LGPL math implementation. Its npm
MIT license alone therefore cannot establish that it is distributable here.
The historical official Linux x64/arm64 samples required at most GLIBC_2.27;
that is neither controlled-runtime evidence nor execution on glibc 2.28.
Controlled GNU Linux denort builds also use `cargo zigbuild --target TRIPLE.2.28`.
Linux release assembly checks the **actual** worker with `readelf --version-info`
and rejects requirements above glibc 2.28; the build argument alone is not ABI
validation. This round built only aarch64 macOS, not the other four targets.

The notice checker consumes the worker's actual esbuild `bundle-inputs.json`.
Release builds also generate `runtime-notices.txt` from that build's non-dev
Cargo metadata closure, fixed Deno source archive, target-specific V8 notices
and exact Rust toolchain. `buildCli` passes this file as `oarRuntimeNotices` to
`verifyNotices`. Each `deno-runtime@2.9.6/TRIPLE` entry in `notices-sources.json`
must name one reviewed local document. Missing target entries, mismatched
version/target headers or any difference between built and reviewed text fail
before Cargo metadata is queried. The normal `notices.json` snapshot still
covers the reviewed content; default generation requires all five target
entries. A macOS document cannot satisfy Linux or Windows coverage.

After a controlled build, `node scripts/oar/runtime-notices.mjs --target TRIPLE`
can regenerate review evidence from its existing receipt, without rebuilding or
fetching another platform's metadata. Files are under
`$XDG_CACHE_HOME/maka/oar-runtime/TRIPLE` (`~/.cache/maka/oar-runtime/TRIPLE` by
default): `license-inputs.json`, `license-records.json` and
`THIRD_PARTY_NOTICES.txt`. The aarch64 macOS document was generated from
760 packages (704 external packages); build dependencies make this conservative,
not a precise linked-object list. It is not a cross-platform closure.

The unavailable SWC revision is no longer treated as the only evidence source:
checksum-verified published crates supply explicit versioned declarations, and
original Rust/core-js, Deno/Node and libdivsufsort copyright notices are retained.
Standard terms added from package declarations are labelled as such, not as
recovered upstream NOTICE files. Published archives can omit referenced files;
available original headers and declarations are retained rather than fabricating
those missing files. The aarch64 macOS full document is retained as
[deno-runtime-2.9.6-aarch64-apple-darwin.txt](licenses/deno-runtime-2.9.6-aarch64-apple-darwin.txt)
and registered only for `deno-runtime@2.9.6/aarch64-apple-darwin`.
The other four targets have neither been built nor reviewed this round and remain
blocked. Development builds do not incur the controlled denort build or this
release notice gate.

For a single reviewed target, supply both its target and the actual runtime
document. Generation always resolves the main Maka Cargo closure for all five
distribution platforms; `--target` selects only the OAR runtime document to include
and compare. Release `check --target` verifies that target's actual dependencies
and runtime. Commands without these arguments still require all five runtime records:

```sh
node scripts/rust/notices.mjs generate --target aarch64-apple-darwin \
  --oar-runtime-notices "$HOME/.cache/maka/oar-runtime/aarch64-apple-darwin/THIRD_PARTY_NOTICES.txt"
node scripts/rust/notices.mjs check --target aarch64-apple-darwin \
  --oar-runtime-notices "$HOME/.cache/maka/oar-runtime/aarch64-apple-darwin/THIRD_PARTY_NOTICES.txt"
```

PR CI uses `node scripts/rust/notices.mjs check-reviewed`. It always checks main
Maka Cargo dependencies on all five distribution platforms. Separately, it derives
the OAR runtime review set from both supplement entries and the existing snapshot
and checks those reviewed texts, without building or fetching other OAR runtimes. Removing a
review entry cannot silently remove coverage, and a newly registered target must
also be present in the snapshot. This checks reviewed source inputs only; it does
not approve a newly built runtime. Release `check --target ...` still requires
and compares the actual build document; default generation still requires all
five distribution targets.

After dependency changes:

```sh
node scripts/rust/dependencies.mjs generate
node scripts/rust/notices.mjs generate
node scripts/rust/dependencies.mjs check
node scripts/rust/notices.mjs check
```

Review the generated inventory and license texts. [notices-sources.json](notices-sources.json) records reviewed upstream exceptions. Release assembly also includes notices from the actual V8 build and Rust standard library. The TSV inventory does not replace full license texts.

`notices.json` records reviewed component identities, sources and license-data digests. `notices check` resolves the Rust dependency closure and builds a temporary product bundle to identify embedded JavaScript packages; it does not download license texts. First-party source edits alone do not invalidate coverage, while importing an unreviewed package already present in the lockfile does. Native packaging checks its target's components and the actual Cargo-produced bundle inputs before packing, reusing that build instead of bundling again. The reviewed catalog may cover additional platforms.

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
