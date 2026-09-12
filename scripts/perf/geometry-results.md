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

# Transcript geometry contract (#5184)

Resident Turns, timeline blocks and code chunks use real layout. The existing
bounded window remains; there is no size index or warm-up traversal.
Publication holds messages and range metadata together during reader input.
The session owns pending publication across viewport detach; the scroll
authority admits it and restores the reading anchor at commit.

## Verification

- Ordinary CI runs `GEOMETRY_REPETITIONS=1 node scripts/perf/geometry-ablation.mjs --assert-stable`.
  Three fixed-range production stories cover mixed Turns, tools and long code.
  Cold upward scrolling must keep height drift and reverse motion within 1px.
- `apps/desktop/e2e/scroll-geometry.spec.ts` exercises the native scrollbar:
  held height/membership, monotonic movement, release-frame anchor and progress.
- `apps/desktop/e2e/transcript-scroll-cost.spec.ts` covers bounded paging and
  reading anchors across range changes with consecutive native wheel ticks.
- Performance commands and comparison limits are in [CI.md](CI.md).
  Timing success alone does not establish statistical non-regression.

The fixed-range probe waits for fonts and Markdown readiness. It does not
establish stability during cold Markdown admission, streaming or media resize.
Scroll timing now covers only the first upward sweep; older reports also
included a downward/upward return and must not be compared as equal workloads.

## Historical evidence

The original experimental modes and results are preserved in Git, rather than
maintained as a second description of current behavior:

- [Pre-change measurement source](https://github.com/apache/maka/tree/817a5737d)
- [Full experimental record before this cleanup](https://github.com/apache/maka/blob/f9cd77cbee8d697a999d61ad716708169275bbe9/scripts/perf/geometry-results.md)

That experiment separated lazy layout drift from window-publication drift.
Its machine-specific measurements are historical evidence, not current-head
performance results.
