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

# maka-sandbox

[简体中文](README.zh-CN.md)

`maka-sandbox` translates Host filesystem and network policies into OS-level command isolation. Call admission and receipt recording live in the Host; child process I/O and lifetime live in [`maka-process`](../process/src/lib.rs).

## Backends

- **macOS** — Seatbelt profiles (`sandbox-exec`). `allowed` networking permits the system `mDNSResponder` socket while keeping other Host Unix sockets blocked; `restricted` networking routes DNS and outbound connections through an execution-owned local proxy.
- **Linux** — `bubblewrap` (`/usr/bin/bwrap` 0.11+) paired with unprivileged network namespaces.
- **Windows** — Prefers [Microsoft MXC](https://github.com/microsoft/mxc) per-command security environments, requiring no UAC prompt, dedicated local user, ACL rewrites on existing files, or `maka sandbox setup`. Read-only carve-outs inside writable trees use crash-recoverable placeholder guards. Policies that MXC cannot express fall back to the low-privilege job-account + WFP backend (configured explicitly via `maka sandbox setup --root <path>`). Failed MXC launches surface an error directly and never silently downgrade to another backend or run unsandboxed.

Across all platforms, unsupported policy rules fail before launch. Destination-restricted policies route outbound traffic through a Host-owned proxy that enforces allowed `(host, port)` pairs, and redirects require matching destination grants.

## CLI and testing

Run a command under an explicit policy JSON file:

```sh
maka sandbox run --policy policy.json --cwd /absolute/workspace --command 'your command'
```

Example read-only, offline policy:

```json
{"kind":"managed","filesystem":{"default":"read","rules":[],"denyGlobs":[]},"network":"denied"}
```

To run the standalone Windows MXC acceptance harness (without building V8):

```powershell
cargo build -p maka-host-runtime --example windows_mxc --target x86_64-pc-windows-msvc
```

Run `windows_mxc.exe` as a standard user on a local volume; it verifies filesystem guards, pipe/ConPTY streams, child-tree cleanup, and loopback/outbound networking.

## Source provenance

`src/seatbelt/{base,network}.sbpl` are copied unchanged from Codex's
[base policy](https://github.com/openai/codex/blob/d1e3f9dfe3d5f6105b7e4c3958b9bf2ac6c32818/codex-rs/sandboxing/src/seatbelt_base_policy.sbpl)
and [network policy](https://github.com/openai/codex/blob/d1e3f9dfe3d5f6105b7e4c3958b9bf2ac6c32818/codex-rs/sandboxing/src/seatbelt_network_policy.sbpl),
revision `d1e3f9dfe3d5f6105b7e4c3958b9bf2ac6c32818`.
Copyright OpenAI; Apache-2.0. The upstream source comments are retained.

`src/windows/mxc.rs` and `src/windows/mxc/{availability,policy}.rs` adapt
native capability probing, networking, filesystem aliases, volume expansion and
startup handling from Codex's [MXC sandbox adapter](https://github.com/openai/codex/tree/4610b573e59b211bf9430cf6ffb97cfb84623090/codex-rs/mxc-sandbox),
revision `4610b573e59b211bf9430cf6ffb97cfb84623090`.
Copyright 2025 OpenAI; Apache-2.0. Maka maps its own filesystem policy, checks
unsupported rules before execution, preserves its command environment contract,
and retains the native owner through process settlement. The Microsoft MXC SDK
is a separate pinned MIT-licensed dependency.
