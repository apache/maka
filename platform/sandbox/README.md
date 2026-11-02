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

Prepares authorized commands for operating-system isolation. The Host decides permission and owns execution records; this crate applies filesystem and network restrictions. Process I/O and lifetime belong to [maka-process](../process/README.md).

macOS uses Seatbelt; Linux uses bubblewrap and network namespaces. Linux requires bubblewrap 0.11 or newer at `/usr/bin/bwrap`. Unsupported policies fail before execution.

Windows prefers [Microsoft MXC](https://github.com/microsoft/mxc), using a native process security environment for each command tree. Maka probes actual creation and startup support, then checks the filesystem policy's requirements. Supported commands need no UAC prompt, dedicated account, changes to existing objects' ACLs or `sandbox setup`. The execution owner retains isolation after the root process exits, until its background processes are settled. Read-only, workspace-write and disabled sandbox choices retain their existing meaning.

For read-only exceptions inside writable trees, the Host reuses recoverable filesystem guards: it creates temporary placeholders for missing paths and pins boundaries and ancestors against renaming. One protected registry per Windows account owns their staging and recovery records. Publishing a placeholder requires a same-volume atomic move that cannot replace an existing object; an unavailable capability is rejected before execution. After the command tree settles, cleanup removes only empty objects created by those guards.

Only unsupported capabilities or policies select the existing low-privilege-account backend, which requires explicit `maka sandbox setup --root PATH` and uses WFP rules and Jobs. A failed MXC launch or cleanup is reported; it never retries the command with another backend or without isolation. The Host remains unelevated.

Destination-restricted traffic passes through an execution-owned gateway. Routing and credentials stay with the Host, and redirects need their own destination permission. Linux and Windows expand deny globs before launch; future matching paths are covered on a subsequent launch, not by that existing snapshot.

On macOS, `allowed` includes the system resolver's `mDNSResponder` Unix socket; other Host Unix sockets remain blocked. Destination-restricted processes use the gateway's resolver instead of gaining direct access to that socket.

Filesystem permissions apply to paths. MXC tightens conflicting object aliases listed in the policy; it does not scan writable trees for pre-existing, unlisted hard links.

MXC networking follows Codex: `denied` blocks network access including IPv4/IPv6 loopback. `restricted` permits Windows host-loopback access, including `127.0.0.0/8`, `::1` and the host's other local interface addresses. Remote destinations must pass through the execution-owned proxy, which enforces the granted destination host and port. Thus the restricted policy permits access to local services beyond the proxy itself. `allowed` permits normal networking.

To exercise a policy with the production backend:

```sh
maka sandbox run --policy policy.json --cwd /absolute/workspace --command 'your command'
```

On Windows, `--root` selects Host state; a supported MXC policy does not require account setup there. A read-only policy with no network is:

```json
{"kind":"managed","filesystem":{"default":"read","rules":[],"denyGlobs":[]},"network":"denied"}
```

Use `maka sandbox --help` for setup, status and removal. These controls constrain model-directed effects; trusted native plugin code runs in the host process.

The native Windows acceptance fixture builds the real Host backend and process transports without the CLI's V8 dependency:

```powershell
cargo build -p maka-host-runtime --example windows_mxc --target x86_64-pc-windows-msvc
```

Run the resulting `windows_mxc.exe` from a Windows local path as a normal user. It creates and removes its own `LOCALAPPDATA` temporary directory and verifies filesystem restrictions, arguments and environment, pipe and ConPTY I/O, descendant lifetime, cancellation, and networking. Its network checks require the unsandboxed host to reach `example.com:443` over TCP as a positive control, then verify DNS resolution and the hostname connection inside an `allowed` sandbox too; no HTTP request is sent. Unavailable MXC support is a failure, not a skipped check.

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
