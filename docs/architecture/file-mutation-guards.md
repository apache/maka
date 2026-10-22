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

# Write/Edit execution-time content guards

Write/Edit calls using the durable ToolRuntime preparation path can reject a target that changes after preparation and before the execution-time check. This is normal execution protection, not crash reconciliation.

## Execution boundary

The filesystem executor holds the existing per-target lock across read-only preparation, the ordinary T1 commit and execution. Preparation records only the canonical workspace/target, directory identities, target identity and bounded pre-state byte count/hash (or a missing target). It does not predict a successful result, compute an expected-after hash, or persist recovery evidence. Runtime owns only the prepared executor's execute/cancel lifecycle; T1/T2 retain their upstream schemas and recovery policy.

Execution checks the same directory identities and the descriptor it will mutate before truncation. A changed identity, content length or hash rejects the write. Missing Write targets use exclusive creation. Edit matching and result/diff construction happen once, during execution. The private argument snapshot cannot be changed through the caller or a returned guard copy. The filesystem worker protocol rejects older versions rather than silently ignoring guards.

## Coverage and limits

- Existing readable regular UTF-8 files up to 1 MiB are eligible. Mutation input strings are bounded to 1 MiB each and must round-trip as UTF-8. There is no predicted-result/diff eligibility limit: results are produced only during execution and retain ordinary result handling.
- Unsupported targets or executors keep the ordinary execution path. Once a guard is established, failed validation never falls back to an unguarded write.
- The snapshot starts at preparation, not at the model's earlier Read. A file changed before preparation becomes the baseline.
- The process-local lock does not exclude Bash or external writers. The final check and write are not atomic across processes; there remains a check-to-write race. This is not a filesystem transaction or compare-and-swap guarantee.
- Both Write and Edit remain `never_auto_retry`. A crash with T1 but no T2 follows the current unknown-outcome contract; no recovery registry, reconciler or bundle writer is introduced.
- Worker-backed eligible calls still require a preparation subprocess and an execution subprocess. Local executors prepare in-process. Calls that did not previously enter durable preparation are not expanded into this path.

Tests are in `packages/runtime/src/__tests__/file-mutation-guard.test.ts`, with worker permission/protocol coverage in `filesystem-worker-client.test.ts` and lifecycle coverage in `tool-runtime-settlement.test.ts`.
