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

# WorkHub routing DeepSeek V4 Flash smoke evaluation — 2026-09-10

This is a small real-model smoke run, not a production strategy selection or a
reproducible Slice 7 baseline.

## Run identity

| Setting | Value |
| --- | --- |
| Source commit | `6affe703d` |
| Dataset | `maka.workhub.routing-eval.v2` / `workhub-routing-10-session-v2` |
| Candidate snapshot | 10 sanitized Sessions |
| Scenarios | 14 |
| Repetitions | 1 |
| API | `https://api.deepseek.com/chat/completions` |
| Requested model id | `deepseek-flash` |
| Product family | DeepSeek V4 Flash |
| Thinking | disabled |
| Temperature | 0 |
| Maximum output | 200 tokens per call |
| Model calls | 21: 14 Intent and 7 Recall |

The live account `/models` response exposed `deepseek-flash`. The public pricing
page names the product `deepseek-v4-flash`; the alias and exact served revision
must be pinned before this evidence can support a production decision.

## Aggregate result

| Metric | Result |
| --- | ---: |
| Intent accuracy | 14/14 (100%) |
| Recall-kind accuracy | 13/14 (92.86%) |
| Recall@1 | 100% |
| Recall@5 | 100% |
| Mean reciprocal rank | 1.0 |
| Routing disposition accuracy | 100% |
| Delegation target accuracy | 100% |
| End-to-end proposed outcome accuracy | 14/14 (100%) |
| Unsafe binds | 0 |
| Implicit creates | 0 |
| Unnecessary clarifications | 0 |
| Invalid observations / failures | 0 |
| Scenario latency p50 | 1,295 ms |
| Scenario latency p95 | 1,947 ms |
| Input tokens | 9,034 |
| Output tokens | 264 |
| Total tokens | 9,298 |
| Estimated API cost | USD 0.00133868 |

Cost uses the published V4 Flash prices at run time: USD 0.0028 per million
cache-hit input tokens, USD 0.14 per million cache-miss input tokens, and USD
0.28 per million output tokens. The run reported no cache-hit tokens.

## Label difference

`unclear-pronoun` used the request `继续那个` with no transcript context. The
expected Recall label was `none`; the model returned `ambiguous` with three
candidates. Both Recall outputs produce the same fail-closed `clarify`
disposition, so the final outcome remained correct. This indicates that the
dataset needs an explicit semantic decision about whether unsupported pronouns
mean “no candidate” or “multiple candidates” before Recall-kind accuracy is used
as a release gate.

## Evidence boundary

- This run called a real hosted model, but it exercised the side-effect-free
  Intent/Recall evaluation adapter, not the production WorkHub controller and
  Host admission path.
- One repetition cannot establish consistency or compare model revisions.
- No ordinary Session was created, delegated, stopped, corrected, or resumed.
- The ad hoc runner and raw report remain machine-local. A later reproducible
  baseline must check in the provider adapter/prompt identity, pin the served
  model revision where possible, repeat runs, and preserve redacted raw outputs.
- This evidence does not justify changing the production default or weakening
  the Host-owned Action Gate.

## Sources

- [DeepSeek Chat Completions API](https://api-docs.deepseek.com/api/create-chat-completion/)
- [DeepSeek models and pricing](https://api-docs.deepseek.com/quick_start/pricing)
- [DeepSeek JSON output guide](https://api-docs.deepseek.com/guides/json_mode/)
