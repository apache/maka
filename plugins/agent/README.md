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
- [model](model/README.md), [providers](providers/README.md) and [responses](responses/README.md) and the pure Rust [provider-protocol](provider-protocol/README.md) core implement model requests and protocols.
- [tool-catalog](tool-catalog/README.md) selects tools; [tools](tools/README.md) dispatches them and provides Code Mode.
- [assistant](assistant/README.md), [goal](goal/README.md), [graph](graph/README.md), [scheduler](scheduler/engine/README.md), [insights](insights/README.md), [session-import](session-import/README.md), [session-recap](session-recap/README.md) and [session-title](session-title/README.md) own their respective features.
- [acp-executor](acp-executor/native/README.md) connects external ACP agents through explicit process and callback services.

The [workbench](../../products/maka/workbench/README.md), which the terminal and desktop shells run, consumes these public Host contracts. Product assembly belongs to [products/maka](../../products/maka/README.md); the workbench owns its draft editor and interaction lifecycle.
