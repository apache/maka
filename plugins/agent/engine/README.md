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

Coordinates durable Agent runs, model steps, tools and recovery. `Engine` reads canonical Run facts and the accepted `RunSpec` from the Agent owner's Root. One driver reconciles outstanding obligations through explicit business ports; native adapters hold the actual authorized resources. Model history projection is separate from UI presentation. Platform Host and UI crates do not depend on this engine.

Recovery preserves the original Run, Step and ModelAttempt identities and settled evidence. It observes original effects rather than submitting them again. Model history projection omits interrupted partial output and reasoning from a different provider route or model without deleting canonical history. Explicit continuation from an eligible terminal Run admits a new Run; it does not resume an old process.

Model requests include the current Session ID and admitted working directory as JSON data in the frozen composition's dynamic context. Main requests, summaries and continuation replay use the same rendering and accounting. Forked sessions use their own ID. Summaries use the current admitted directory even when reusing an earlier request's static prompt after project relocation; earlier request evidence remains unchanged.

Verified archive evidence retains its canonical encoding and frozen page. Current model history adds capability-neutral continuation guidance before request accounting and hashing; without a selected Session tool-result reader, the remainder is unavailable. Recovery validates recorded execution evidence and tool selection against the current authorized source. Changed prerequisites produce a typed blocker, not a replacement execution or a parked process checkpoint.

Vision history projection reads each authorized image in full under the existing artifact storage limit. Copied sessions resolve retained images through destination-owned references.

Automatic compaction calibrates the current prompt estimate against the latest matching Main request’s measured input. Only changes since that request, including archived tool results, are estimated. Normalized usage already includes cache and reasoning tokens. At 85% of the resolved adoption threshold, the engine starts a background summary alongside Main. The default adoption threshold is 85% of the effective input limit. At that threshold or after a provider overflow with no accepted output, the engine adopts a compatible completed summary and replays the history after its original cut. A later run in the same session can reuse a completed candidate once it reaches the adoption threshold. An unfinished summary follows normal cancellation when the run ends. Summary input fitting has its own budget.

[Source](src/lib.rs) · [Cargo manifest](Cargo.toml)
