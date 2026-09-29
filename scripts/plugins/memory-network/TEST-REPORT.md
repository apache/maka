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

# Memory Network validation

## Controlled validation

`npm run verify`: **9 tests passed**, including source-directory and exported `.maka-extension` installation into the actual HostPluginPlatform/Context and tool invocation through PluginToolService and PluginSessionQueryService. Business Session snapshots are fixtures; no live personal history was used.

Coverage: cross-Session import; two indexes sharing originals; reverse links; stale candidate removal after new source evidence; independent per-index coverage; bounded/frozen batches; arrivals during organization; stale competing submissions; identical/different replay; atomic rollback on invalid citations; reopening an unfinished batch; exact Unicode reconstruction across long-message fragments; immutable original versions and current-version navigation; denied visibility; restored visibility; newly created Sessions handled incrementally without full rescan. Privacy validation rejects incognito/unknown state and excludes fake/archived histories using Recall's rules.

Existing regression tests: **70 passed** across core Recall, plugin P1 services and plugin tool service. Core and runtime builds passed; runtime-host typecheck passed. These do not constitute a desktop UI test.

## Real model smoke test

Model: `deepseek-flash`, called through Maka's real AiSdkBackend, using the installed exported extension and two synthetic Session histories. No real supplier/calendar action was available or performed.

Passing run: `.artifacts/live/report-1790669103313.json` — **27.118 seconds, 11 model requests, 2 conversation turns, no tool errors**.

1. Agent defined its own criteria for `todo` and `timeline`, read fixed original batches and committed linked entries. It opened originals and inspected backlinks.
2. A later original reported the vendor had already been contacted and must not be contacted again. Agent read the unorganized delta, removed the old contact candidate, retained a delivery follow-up, and preserved the original discussion and resolution in the timeline.
3. Final state: one Todo entry, three timeline entries, both indexes covered through fragment 3, with no remaining delta. Originals stayed intact.

An earlier run (`report-1790668926813.json`) exposed unnecessary exclusive-step tool declarations, which were changed to parallel-safe transactional calls. Its final evaluator also falsely treated the sentence “do not contact the vendor” as an outstanding task; the evaluator now checks that the original candidate IDs were actually removed. The earlier failed report was retained. The passing run used the corrected declarations and evaluator.

The smoke test validates this concrete scenario, not general model summary accuracy. It does not benchmark huge histories or test background scheduled maintenance. Source ingestion is currently full Session snapshot reading on demand; organizing and coverage advance are incremental.

## Reproduce

```sh
npm install
npm run verify
node scripts/prepare-test-metadata.mjs
node scripts/live-api.mjs
# Supply MAKA_SCENARIO_API_KEY in the environment; optionally MAKA_SCENARIO_MODEL.
node --import tsx scripts/live.ts
```

No credentials are written to tracked files. Raw test reports are local ignored artifacts.
