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

# Computer Use Host Events Contract

This layer connects only events with a typed, attributable source.

## Connected producers

- Typed dispatch outcomes:
  - `user_intervened` -> re-observe
  - `screen_locked` -> locked
  - `blocked_url` -> terminal URL block
  - `outcome_unknown`, service unavailable, or service mismatch -> re-observe
- Executor service release:
  - clears executor-local observations and keyboard ownership
  - advances the corresponding Runtime session to re-observe
- Turn/session terminal events:
  - synchronously clear Runtime, executor, and overlay ownership

## Deliberate gaps

- Maka does not infer physical user input from AX or DOM content changes.
- Maka does not claim a global physical-input producer until it has a reliable,
  attributable macOS event source.
- Maka does not invoke Codex's signed `turn-ended` helper. That helper uses an
  Apple Event lifecycle specific to the Codex native service, and helper process
  exit is not proof that service cleanup completed.
- Runtime URL, lock, and intervention states require typed driver outcomes; raw
  error-message matching is not an accepted producer.
- The current driver exposes no trustworthy intervention debounce deadline, so
  a typed intervention advances directly to re-observe. The two-stage debounce
  state remains reserved for a future attributable deadline producer.
- Maka currently binds targets by PID/window/content/page identity. The V10
  reverse-engineered boundary is stronger: canonical app path plus the current
  live process instance. Maka does not claim that boundary until the executor or
  a native host API can provide an atomic, high-precision process identity.

## Verification

The cross-layer deterministic harness covers:

- bound target propagation;
- observation-bound presentation and dispatch;
- fresh post-action observation;
- duplicate and stale rejection;
- typed target-change cancellation;
- unknown outcome requiring re-observation;
- explicit session cleanup;
- private UI content omission from persisted tool text while current-turn model
  projection retains the UI evidence needed for action.

Target/decoy execution, real process restart, persistence-level privacy,
Desktop terminal lifecycle, real macOS event production, and real-window
cumulative Electron verification remain separate release gates.
