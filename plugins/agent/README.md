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

# Agent plugins

[简体中文](README.zh-CN.md)

This family owns Agent business behavior. Leaf `package.ts` files declare independently composable features. The Rust crates below support those declarations; their names describe code ownership, not implicit activation.

- [facts](facts/README.md), [api](api/README.md) and [ports](ports/README.md) separate persisted data, wire contracts and business interfaces.
- [authority](authority/README.md) checks the original invocation; [native](native/README.md) exposes Host services; [engine](engine/README.md) runs Agent work.
- [provider-protocol](provider-protocol/README.md) owns the three wire codecs; [model](model/README.md) owns their execution adapters; [providers](providers/README.md) owns provider definitions, authentication and discovery.
- [tool-catalog](tool-catalog/README.md) selects tools; [tools](tools/README.md) dispatches them and provides Code Mode.
- [assistant](assistant/README.md), [goal](goal/README.md), [scheduler](scheduler/engine/README.md), [insights](insights/README.md), [session-import](session-import/README.md), [session-recap](session-recap/README.md) and [session-title](session-title/README.md) own their respective features.
- [acp-executor](acp-executor/native/README.md) connects external ACP agents through explicit process and callback services.

The [workbench](../../products/maka/workbench/README.md), which the terminal and desktop shells run, consumes these public Host contracts. Product assembly belongs to [products/maka](../../products/maka/README.md); the workbench owns its draft editor and interaction lifecycle.

## Subagent preset management

The Agent service exposes `presets`, `preset`, `createPreset`, `updatePreset` and `deletePreset`; see the [wire contract](api/src/preset.rs). Presets start empty and persist within the Host's Agent scope. Lists omit instructions; details preserve the complete text. Model references contain no credentials.

Updates and deletes require `expectedRevision`. Omitted update fields stay unchanged; `instruction: ""` clears the instruction and `thinkingLevel: {"kind":"default"}` restores the model default. A thinking level is set with `{"kind":"set","value":"high"}`. Model or thinking changes validate the selected native model; other edits and deletion remain available when a connection disappears. Names are trimmed and unique within the scope.

Each mutation and its result commit atomically through the Host operation journal. If a reply is lost, recover the original operation reference instead of issuing another mutation. The default product exposes these methods as `SubagentPresetList/Read/Create/Update/Delete` tools. `SessionCreate` applies a preset by ID; `SessionSend` supplies the task.
