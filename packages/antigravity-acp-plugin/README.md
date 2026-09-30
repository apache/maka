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

# Antigravity ACP executor Plugin

This package is the thin Antigravity adapter for Maka's shared ACP Runtime Plugin. It owns only the
Antigravity executable/helper paths, launch environment, and optional initial model value. The parent
`acp-runtime` Entry owns ACP processes and Sessions; Maka sees only the registered
`antigravity-acp` executor and ordinary Session events.

Build the repository, install this directory with `plugin.package.install`, then add a profile Entry:

```json
{
  "type": "insert",
  "rootId": "profile",
  "parentId": "acp-runtime",
  "entry": {
    "id": "antigravity-acp",
    "packageId": "antigravity-acp",
    "config": {
      "executable": "/absolute/path/to/agy_acp_server.par"
    }
  }
}
```

The parent Entry is contributed when the `acp-executor` dependency is installed.

In production, Runtime Host ships both bundles and derives this Entry from the executable saved by
the existing external-Agent setup flow. The derived package layer is content-addressed, restored on
restart, and removed when the setting is cleared; the adapter itself never reads RuntimePolicy.

Create a Session with `executorId: "antigravity-acp"`. The executable and its
`localharness_external` helper remain adapter-owned. An optional `model` configuration is validated
against the live ACP Session before the first prompt.

## Process lifetime and current limits

After its first prompt, each Maka conversation retains one external ACP process, including while it
waits for the next turn. Closing the Desktop UI does not retire the conversation. PR 2 has no idle
timeout or process-count cap, so a long-running Host can accumulate processes as conversations are
created. This preserves multi-turn continuity while PR 2 cannot restore an external Session after
process loss. Retiring a task releases its process; reloading, disabling, or uninstalling the Plugin
and shutting down the Host also terminate owned process trees. A lost process leaves readable Maka
history, but that task cannot continue until same-Session restoration is implemented and verified
in PR 3. Bounded retention is tracked separately in
[#5620](https://github.com/apache/maka/issues/5620), informed by that restoration behavior.

The ACP `session/new` request currently passes `mcpServers: []`, so this integration does not
forward Maka MCP servers to Antigravity. PR 2 execution acceptance reused an existing Google login;
it does not establish recovery from expired authentication during a task. Fresh interactive login
was verified in the PR 1 setup flow.

The first successful model catalog is cached for the lifetime of the executor Entry. Server-side
model changes without an Entry replacement are not reflected until the Plugin is reloaded. PR 4
owns catalog invalidation and refresh reconciliation.
