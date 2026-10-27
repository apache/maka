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

# maka-processes-native

[简体中文](README.zh-CN.md)

Provides workspace command, terminal and protocol-process services. `protocol` handles structured subprocess communication; `terminal` manages interactive terminal resources. Configuration supplies the installation ceiling, and each call still needs its own authority. Closing an observer does not terminate ownership of a running process.

The workspace-write sandbox permits writes in the selected workspace and system temporary directories. Tool caches elsewhere need an explicit writable location. For example, [mise](https://mise.jdx.dev/directories.html) defaults to `~/Library/Caches/mise` on macOS; select a cache before starting mise:

```sh
mise_cache=$(mktemp -d "${TMPDIR:-/tmp}/maka-mise.XXXXXX")
MISE_CACHE_DIR="$mise_cache" mise exec -- node --version
rm -r "$mise_cache"
```

Reuse a dedicated directory inside the selected workspace for a persistent cache. Pass `MISE_CACHE_DIR` in the command environment before shell startup if shell initialization invokes mise; setting it in `mise.toml`'s `[env]` is too late. This relocates the cache without granting access to the user's global cache. Read-only mode still requires write permission for cache creation, and tool downloads require separate network permission.

Live terminal screens and background-process logs come from the original worker handle. Output alone does not update the durable resource revision, `updatedAt`, or `watchList`; start, state, actual resize and final output still commit durably. Detail watches accept new output at the same durable revision. After a Host crash, orphan recovery retains the last durable snapshot, which may predate the last live output.

`health` (the default `BackgroundTaskHealth` model tool) reads the original session-owned process, including live logs when retained. `updatedAt` denotes the last durable resource update, not output activity or endpoint health. Logs require `include_logs: true`. An optional HTTP(S) URL is probed by the bound Web service under separate network permission; the process result and endpoint observation are independent. A responding endpoint proves neither listener ownership nor browser readiness. Health calls and their nested probes retain original operation receipts.

The Terminal [raw output contract](../../api/README.md) uses the original PTY owner and complete replay in two resource-owned anonymous temporary files. Temporary storage grows with output and is released when the original resource and all existing readers are dropped. Closing an output observer leaves the process and controller unchanged; existing sequenced control and mutation receipts retain their original authority.

[Source](src/lib.rs) · [Cargo manifest](Cargo.toml)
