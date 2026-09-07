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

# Renderer performance probes

Measuring what a session switch costs in the running Desktop app, over CDP. The
findings in #4109 were produced with these; they live here so the next
measurement is a command rather than a rebuild.

They are ad-hoc tools, not a benchmark suite: they attach to a dev app you
started, and they answer "how much" only for the interaction they drive.

## Running

Start the dev app with the debugger open:

```bash
npm run dev -w @maka/desktop -- --remote-debugging-port=9334
```

Then, with a populated sidebar (about 30 rows is what the #4109 numbers used):

```bash
node scripts/perf/session-switch-commits.mjs before
node scripts/perf/session-switch-busy-js.mjs
```

- `session-switch-commits.mjs` — React commits per switch, how many are
  full-tree renders, and how many fibers actually re-rendered. Reloads the page
  first, so `react-commit-probe.js` is in place before React boots.
- `session-switch-busy-js.mjs` — renderer busy JS per switch, with the top
  self-time entries. It reports the running build, one configuration. A
  before/after needs both configurations in one instance; see below.
- `react-commit-probe.js` — the in-page half: a minimal
  `__REACT_DEVTOOLS_GLOBAL_HOOK__` plus a `Function.prototype.bind` wrapper that
  catches React creating a `dispatchSetState`, so a commit can be attributed to
  the `setState` that caused it.
- `cdp-client.mjs` — the protocol client and the row-clicking helper.

## The one rule

**Never compare numbers from two app launches.** Restarting the app shifts these
metrics by orders of magnitude, while the spread inside a single running
instance is small. An A/B means: one instance, a `globalThis` switch to select
the configuration, at least three repetitions per configuration, alternating,
compared pairwise. Two runs of "before" and "after" against two launches will
produce a confident number that means nothing.

The switch is a throwaway, not a shipped affordance. Branch a worktree, put a
`globalThis` flag in the one place that reads it — one that restores the old
behaviour when set, so the regressed configuration is reachable without
rebuilding the defect by hand — alternate the flag inside the running instance,
then delete the worktree. Measurement discipline is ours; product code carries
none of it. A flag that reaches `main` is a branch nothing executes and a
defect replica that has to be maintained against the code it replicates.

Two smaller ones that cost time to rediscover:

- Clicks must be `Input.dispatchMouseEvent`. A synthesised `element.click()`
  does not activate an Astryx `SideNavItem`, so the app does nothing and the
  measurement describes it.
- Disarm the commit probe (`__MAKA_PROBE__.arm = false`) before sampling. Its
  fiber walk otherwise shows up in the profile as the app's own work;
  `session-switch-busy-js.mjs` does this for you.

## What these do not tell you

The commit count is unweighted, and busy JS on this workload is spread across
about a thousand cheap fibers rather than concentrated in one component. A
change that lowers the commit count has not necessarily lowered the time, and a
change that moves the top self-time entry has not necessarily lowered anything.
Read both, and read the medians.
