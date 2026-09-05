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

# Computer Use Delivery State

This follow-up preserves delivery uncertainty after a native or Electron action
has reached the executor.

## Problems

- AX and CDP text writes became `capture_failed` when readback did not confirm
  the value, even though the write had already been delivered.
- A successful semantic action became `capture_failed` or
  `sensitivity_blocked` when its required fresh screenshot failed.
- A failed screenshot observation was stored before normalization and could
  evict an earlier usable observation.
- The model-facing description still claimed Electron text was always refused.

## Fix

- Delivered but unverifiable writes and semantic actions return
  `outcome_unknown`.
- Fresh-capture errors after dispatch retain the action's delivered state.
- Observations enter the bounded FIFO only after screenshot normalization
  succeeds.
- The tool description documents the unique CDP click and text path.

These changes do not weaken pre-dispatch freshness, identity, occlusion, or
physical-input checks.
