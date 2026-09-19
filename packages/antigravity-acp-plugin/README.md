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

The Plugin retains one external process per Maka conversation while the Host is running. Reloading,
disabling, or uninstalling the Plugin cancels active work and terminates every owned process. Same-
Session restoration after a Host restart remains intentionally unsupported until ACP resume/load
semantics are implemented and verified.
