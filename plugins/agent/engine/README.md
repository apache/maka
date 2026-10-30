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

# maka-agent-engine

[简体中文](README.zh-CN.md)

Coordinates Agent runs, model steps, tools, handoffs and recovery. `Engine` consumes explicit business ports and authorized resources; `RunInput` and `RunWork` describe admitted work. Model history projection is separate from UI presentation. The native Agent service owns activation and delegates execution here; platform Host and UI crates do not depend on this engine.

Resuming a run preserves its original input and settled history. Replay omits interrupted partial output and reasoning from a different provider route or model without deleting canonical history. New model steps use the current authorized tool state.

Model requests include the current Session ID and admitted working directory as JSON data in the frozen composition's dynamic context. Main requests, summaries and continuation replay use the same rendering and accounting. Forked sessions use their own ID. Summaries use the current admitted directory even when reusing an earlier request's static prompt after project relocation; earlier request evidence remains unchanged.

Verified archive evidence retains its canonical encoding and frozen page. Current model history adds capability-neutral continuation guidance before request accounting and hashing; without a selected Session tool-result reader, the remainder is unavailable. Sealed handoffs require the exact recorded request projection and tool catalog, so an upgrade that changes either can refuse that handoff.

Vision history projection reads each authorized image in full under the existing artifact storage limit. Copied sessions resolve retained images through destination-owned references.

[Source](src/lib.rs) · [Cargo manifest](Cargo.toml)
