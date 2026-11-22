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

# Native Build and CI Tooling

[简体中文](README.zh-CN.md)

Scripts under `scripts/rust/` and `scripts/ci/` manage native cross-platform packaging, V8 prebuilt caching, third-party license/notice verification, and CI suite execution. See [`packages/cli`](../../packages/cli/README.md) for end-to-end release commands.

## Toolchain and V8 prebuilts

- **macOS** — Xcode 26+ and `libclang` (required by SQLite preupdate-hook bindgen).
- **Linux** — GLib, X11/XCB, `xkbcommon`, Wayland, Fontconfig, FreeType dev headers, `libclang`, `cargo-zigbuild`, and Zig (exact versions match [`.github/workflows/npm-publication.yml`](../../.github/workflows/npm-publication.yml)).
- **V8 cache** — Release builds pull pinned V8 archives (with LGPL glibc math disabled) from [`v8-prebuilts.json`](v8-prebuilts.json) into `target/v8` (`$CARGO_TARGET_DIR/v8`) and verify SHA-256 digests. A missing pin falls back to a full V8 source build (requires Python, Git, Clang/libclang 19+, and significant disk/CPU).

## Dependency and notice inventories

After changing Cargo or bundled JavaScript dependencies, regenerate and verify the license inventories:

```sh
node scripts/rust/dependencies.mjs generate
node scripts/rust/notices.mjs generate
node scripts/rust/dependencies.mjs check
node scripts/rust/notices.mjs check
```

`notices.json` tracks reviewed Rust and bundled JS components across all distribution targets; [`notices-sources.json`](notices-sources.json) records reviewed upstream license URLs.

## CI

Suite definitions live in [`scripts/ci/suites.mjs`](../ci/suites.mjs) and run identically in local `just` recipes and [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml) via [`scripts/ci.mjs`](../ci.mjs):

```sh
node scripts/ci.mjs plan --base origin/rust-preview
node scripts/ci.mjs run bridge
```

PR plans trace reverse Cargo dependencies plus declared runtime assets (`skills/`, product bundles, helper binaries); shared build inputs select the full suite matrix. The root build job produces a single `cargo nextest` archive (including embedded runtime assets) that downstream OS test runners partition and execute.

## Benchmarks

[`host-comparison/`](host-comparison/README.md) provides an offline Linux harness for comparing end-to-end Host throughput, RSS, and CPU usage against a local loopback SSE model fixture.

## Windows State Root ownership recovery

Maka creates State Root directories under `%LOCALAPPDATA%\Maka` owned by the current Windows user with a private ACL. If an older elevated process left `state-root-owners` or `runtime-hosts` owned by `Administrators` (`S-1-5-32-544`), Maka refuses to adopt it automatically and prints both SIDs. To recover your own directory after stopping all local Hosts, run in an elevated PowerShell:

```powershell
$path = 'C:\Users\YOUR_ACCOUNT\AppData\Local\Maka\state-root-owners'
$acl = Get-Acl -LiteralPath $path
if ($acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne 'S-1-5-32-544') {
    throw 'Expected an Administrators-owned directory.'
}
$backup = [System.IO.Path]::GetTempFileName()
$acl.Sddl | Set-Content -LiteralPath $backup
$acl.SetOwner([System.Security.Principal.WindowsIdentity]::GetCurrent().User)
Set-Acl -LiteralPath $path -AclObject $acl
Write-Output "Backed up previous SDDL to: $backup"
```
