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

# maka-workspace-api

[简体中文](README.zh-CN.md)

Defines the shared contracts for workspace files, processes, terminals, protocol processes and Decisions API. Native providers and authoring tools use the same declarations. Request paths and workspace identifiers describe a selection; the provider still checks the actual bound directory and call authority.

`Files.readText` reads workspace text and Session attachment or archived tool-result resources under the caller's original invocation authority. It accepts the complete returned `next` object for continuation; an address grants no access to another Session. Agent tool descriptions expose this capability under the selected tool's name. `readImage` does not read tool-result archives.

The Terminal contract exposes `readOutput` and `watchOutput` for complete ordered original PTY bytes (Base64) and native resize events retained by the original live resource. Adjacent Data records are combined within the 64 KiB encoded subscription Item budget (about 48 KiB of raw bytes, after envelope and Base64 overhead); there is no tail eviction. A Data sequence is the last consumed native record, so sequences can jump while every Resize stays separate. Keep `after` with its original target; any original cursor, including one inside a delivered batch, still selects its exact suffix. A fresh parser subscribes directly with `watchOutput(after: 0)`, resets once to the first retained event’s `initialSize`, then consumes every Data/Resize in order. An intact parser can resume after its known sequence. Existing readers can drain after worker retirement, but a new attachment after retirement or Host restart reports `Unavailable`; a prior `readOutput` query does not reserve a later attachment. Real replay I/O failures fail the call. Retained displays and plain screen reads are not parser checkpoints. `Closed` means byte-source closure, not confirmed process cleanup. Output observation needs explicit method grants, not a controller.


For a settled PTY, `readDisplay` is a finite subscription of one durable revision: `begin` carries geometry, cursor, palette and input-mode metadata; ordered `rows` carry styled physical cells; `end` completes the display. `begin` and `rows` are streamed items; the single `end` is the final successful subscription result. Stage parts privately and replace the visible display only at `end`; discard incomplete or canceled transfers. Desktop uses this after `watchOutput` reports `Unavailable`, preserving colors and styled blanks through retirement and Host restart. It never resumes a raw parser from these cells. `read`/`watch` keep their bounded plain model projection, independently of display retention.

Native history uses an 800,000-cell allowance (10,000 rows at 80 columns), adjusted before resize reflow. Geometry permits 2–1,024 columns and 1–1,024 rows, with at most 65,536 visible cells. The encoded display retains the current and last alternate viewports first, then newest whole history rows within 64 MiB; omitted history is marked truncated. These replace the old 500-row and 4 MiB whole-record limits. Existing text-only terminal records migrate once with their known text and default styles; already discarded colors cannot be recovered. See [display types](../../agent/facts/src/terminal/display.rs) and [native geometry](../../agent/facts/src/terminal.rs) for the resource policy.

[Source](src/lib.rs) · [Cargo manifest](Cargo.toml)
