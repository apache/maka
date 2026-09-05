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

# Computer Use Executor Hardening

This note records the post-merge review of PR #893 against the current
`cua-driver` executor and the local Codex Computer Use reverse-engineering
evidence.

## Fixed In This Follow-Up

- Semantic refetch now requires one unique role/label/value candidate and then
  verifies that its frame, depth, and value still match the observed control.
  A same-label replacement or ambiguous candidate set fails closed.
- Native content fingerprints include label and value, so a control changing
  meaning in the same structural slot invalidates coordinate actions.
- Window screenshots use the same compression threshold and 8 MiB cap as
  desktop screenshots.
- Unconsumed observations are bounded to 16 per session and evicted FIFO.
- Keyboard ownership is invalidated when the bound PID or window no longer
  matches the click-established target.
- Delivered but unverifiable Electron pointer actions and delivered text writes
  preserve `outcome_unknown` instead of becoming retryable `capture_failed`
  results.
- `select_text` and `secondary_action` fail closed because the pinned driver
  registry does not expose their claimed tools.

## Deliberately Not Changed

- Coordinate click, scroll, drag, and key dispatch remain disabled by default.
  Re-enabling the compatibility CGEvent path would restore the physical-input
  interference found during real-machine testing.
- The physical-input callback remains optional at this executor layer because
  semantic AX/CDP operations are also used by non-Desktop hosts. Desktop wiring
  must supply the guard before advertising concurrent-user safety.
- The process-wide operation queue remains global. Maka currently owns one
  action-child stdio connection, and the fresh-snapshot/action pair must remain
  atomic across that shared connection. The Codex native service supports
  concurrency through separate connections while serializing one connection
  and one application instance. Removing the queue without introducing
  separate service connections broke the existing ordering contract.

## Remaining Work

- If cross-session concurrency becomes necessary, create isolated driver
  connections or per-target service instances and preserve snapshot/action
  transactions explicitly.
- Initial `observeApp` failures cannot return the full typed capture result
  through the current observation-only interface. The backend still enforces
  the screenshot cap, but the Runtime interface needs a result-bearing
  observation contract to preserve `sensitivity_blocked` end to end.
- Continue real-provider model-loop testing with coordinate actions fail closed
  until an isolated native event executor exists.

## Verification

The focused `@maka/computer-use` suite passes 111 tests, including semantic
replacement, registry mismatch, observation eviction, window compression,
shared-client ordering, lifecycle error, and keyboard-target regression cases.
