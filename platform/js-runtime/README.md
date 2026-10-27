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

# maka-js-runtime

[简体中文](README.zh-CN.md)

Provides the V8 execution machinery shared by plugin guests and persistent JavaScript REPLs. `plugin` implements bounded guest execution; `repl` and `CodeExecutor` support cells that retain variables between calls. Embeddings supply callable capabilities and own their resources. A JavaScript promise finishing does not prove that the native work it started has settled.

Nested tool calls pass complete JSON inputs and results through the embedding's original executor. A cell can consume a large tool result and publish a short summary; complete cell results, emitted output and scratch values remain available under the configured V8 heap and execution deadline. Admitted tool work remains tracked until cleanup, including when JavaScript stops observing its promise.

REPL timeouts charge ordinary awaits as well as JavaScript execution. A trusted Host can hold a `CellContext::suspend_timeout()` guard around an approval or native wait whose contract excludes that time. Nested and concurrent guards resume the remaining allowance when the last wait ends; executing JavaScript still consumes it. JavaScript has no suspension API, and cancellation and heap limits remain active.

`Repl::new` drains admitted work before reporting interruption and requires a new VM afterward. `Repl::new_observed` lets a trusted Host supply a `ReplAdmission` fence: the interrupted VM closes admission, waits for durable effect custody or confirmed refusal, and publishes its result while the same worker continues polling the original effects. The Host retains that REPL and joins `close()` to confirm settlement and receive late persistence or cleanup failures. A failed fence drains work before returning its error. Creating a fresh VM, native bindings and resource owners remains the embedding's responsibility.

[Source](src/lib.rs) · [Cargo manifest](Cargo.toml)
