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

# Workspace plugins

[简体中文](README.zh-CN.md)

Workspace services can be composed independently of the Agent engine. Each leaf declaration selects a native provider, while UI consumers bind the contracts they need.

- [Files](workspace-files/native/README.md) uses the file [engine](workspace-files/engine/README.md) and pure [patch parser](workspace-files/patch/README.md).
- [Processes](workspace-processes/native/README.md) owns commands, terminals and protocol processes.
- [Web](workspace-web/native/README.md) provides fetch and search; its [API crate](workspace-web/api/README.md) contains the declarations.
- [Decisions API](workspace-decisions-api/native/README.md) exposes the structured evaluation [engine](workspace-decisions-api/engine/README.md).
- Computer Use exposes `cua_repl` and `cua_reset` through the [native provider](workspace-computer/native/src/lib.rs). Each conversation needs explicit access approval. Changing its permission boundary invalidates that grant; Explore mode cannot operate the computer. REPL variables and target bindings last until reset or Host shutdown, while the conversation grant survives restart. Desktop and browser connections are selected in the provider configuration.

The shared [API](api/README.md) defines workspace contracts. [Support](support/README.md) handles configured roots, path resolution and private-path exclusions. A service receives its resource limits and authority explicitly; a path in request JSON cannot widen them.

Files and Processes return `permission_denied` for a confirmed Host refusal before execution, preserving the target permissions, command and reason. The reasons distinguish disabled requests, explicit user denial, protected boundaries, insufficient approval and expired grants. Cancellation and observation failures are separate errors. Process status and exit evidence remain independent of permission reasons; stderr containing `EPERM` alone is not evidence of a sandbox refusal.
