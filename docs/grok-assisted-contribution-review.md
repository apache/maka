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

# Grok-assisted contribution review

**Baseline:** `bfb315acc` (2026-09-27). **Status:** inventory; implementation review pending.

This is a provenance and engineering inventory, not a legal classification or
an assertion that these changes must be removed. The scope is merged PRs whose
Grok-assisted work was committed on or after 2026-08-14, the effective date of
the xAI Acceptable Use Policy change under discussion. The scan matches
`Generated-by: .*Grok` in commits reachable from `origin/main`, then checks PR
disclosures for contributions without that trailer. A trailer does not establish
which individual lines were generated; a PR without one can still disclose use.

| PR | Main commit | Area | Evidence |
|---:|---|---|---|
| #3008 | `2632b8506` | Eval egress | Commit trailer |
| #2967 | `1ce0bc308` | Eval egress | Commit trailer |
| #3048 | `a75640f43` | Desktop transcript | Commit trailer; mixed-tool PR |
| #3063 | `0dc3e5ec3` | Runtime cleanup | Commit trailer |
| #3066 | `d6bef01d3` | Eval framework | Commit trailer |
| #3070 | `9fbdc99a2` | Desktop projects | Commit trailer |
| #3078 | `887af0c9d` | CI inventory | Commit trailer |
| #3082 | `2666a579a` | Runtime PTY | Commit trailer |
| #3099 | `4bded3b21` | Desktop rail | Commit trailer |
| #3101 | `84a579db6` | Desktop tests | Commit trailer |
| #3102 | `5ef39c350` | Desktop bridge | Commit trailer |
| #3104 | `8a11c9f2b` | Runtime graph | Commit trailer |
| #3106 | `a79f69185` | Runtime Host tests | Commit trailer |
| #3111 | `cdf023dc0` | Desktop fixtures | Commit trailer |
| #3115 | `c92d0a22a` | Rate limits | Commit trailer |
| #3117 | `12d2ab54e` | Storage cleanup | Commit trailer |
| #3118 | `dd02553aa` | xAI model discovery | Commit trailer |
| #3119 | `802fe8977` | Desktop Plan Mode | Commit trailer |
| #3123 | `2e3c82e10` | Desktop tests | Commit trailer |
| #3069 | `4ffc823fd` | Desktop search | Commit trailer |
| #3459 | `b434a491a` | Terminal handling | Commit trailer; mixed PR |
| #3364 | `3ab0605b3` | Relative time | Commit trailer; mixed PR |
| #3544 | `dc9d2f0dd` | Composer queue | Commit trailer; mixed-tool PR |
| #4345 | `472fea02b` | Architecture docs | Commit trailer; mixed-tool PR |
| #5223 | `aa3f8e538` | Project path validation | PR AI-use disclosure; no Grok trailer |

PR #2956 disclosed Grok but merged on 2026-08-13, before the selected date,
so it is outside this inventory. Closed, unmerged PRs are not in the current
mainline and are tracked separately: #4809, #4899, #5102, #5342, #5349,
#5350, and #5497.

## Review protocol

For each row, verify the original behavior and tests against current `main`,
identify subsequent changes or removals, and record the current affected files
and an explicit disposition. Do not count a rewritten commit message, a
reformat, or a no-op reimplementation as a provenance remedy. Any replacement
must be an independently reasoned change with behavior and regression evidence;
the earlier history and contributor disclosures remain intact. The scope and
acceptability of any remediation need Apache project/legal review.

## Open work

- [ ] Inspect all 25 PRs and map their changes to current code and tests.
- [ ] Record which changes are still material, superseded, or mixed with other work.
- [ ] Decide the appropriate action with the project and ASF legal discussion.
- [ ] Implement and verify any agreed replacements in reviewable slices.
