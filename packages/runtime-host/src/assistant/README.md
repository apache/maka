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

# Native personal assistant

The Runtime Host owns three built-in services: memory indexes, durable Matters, and the ordinary personal-assistant conversation with optional proactive heartbeats. They do not install extension packages, register Plugin fibers, or depend on desktop plugin slots. Feishu remains an independently authorized source plugin.

`service.ts` owns tools, prompt contributions, the Matter finish check, the fixed desktop API, scheduler startup and shutdown. `execution-composition.ts` recovers its state after source plugins, and starts schedulers after execution recovery. Shared Host agent, model, history and source adapters retain invocation identity and permissions; using these adapters does not install a plugin.

The feature defaults **off**, including installations with existing assistant data. Enable **通用 → 启用个人助手** in Settings, beside the WorkHub switch, to expose the sidebar entry and start the three services on that Host. The switch is shared by clients of the same Host, not a desktop-only visibility preference. Its labeled conversation is excluded from the ordinary Session rail and palette. WorkHub remains separate. Opening the assistant does not import history, create indexes, enable discovery or call a model.

## Master switch

`personal-assistant/enablement.json` stores the Host-owned opt-in. With it absent or disabled, the Host does not import the modules, open their databases, adopt old plugin data, register assistant tools/prompts/finish checks, or run any assistant schedulers. The two allowlisted desktop operations `assistant.enablement` and `assistant.set-enabled` remain available; feature operations reject while disabled.

Disabling fences new calls, aborts in-flight tools, stops assistant/worker Sessions and all three schedulers, then closes their stores. Captured tools from a retired runtime reject further calls. Transitions serialize so re-enabling cannot overlap the previous generation. Session admission also checks the switch so old queued messages cannot restart disabled assistant workers. Ordinary conversations and WorkHub are unaffected.

Existing indexes, originals, coverage, conversations and task state remain on disk. Re-enabling restores saved scheduling preferences and overdue work; interrupted tasks that were paused by shutdown require explicit recovery in Settings. Switching the feature on does not import history or enable proactive heartbeats for a new user. Feishu remains a separately controlled plugin; this switch stops assistant access/maintenance, not unrelated uses of that plugin.

## Existing data

On first explicit enablement, `personal-assistant/assistant.json` in the Host control directory records each component's directory and configuration. Existing `data-directory` storage and profile configuration from the three retired plugin packages are adopted in place. Databases, references, checkpoints, delegated sessions and feedback receipts keep their existing formats and paths. No database is copied or rebuilt. An invalid or ambiguous configuration fails explicitly instead of opening an empty replacement.

The Host suppresses the three former packages on every composition projection, including later enable/reload attempts. Their persisted configuration and package data are retained; Feishu is not suppressed. Restarting uses the native settings file as the authority. Native feature lifetime no longer depends on plugin installation or reload.

Memory defaults remain 12-hour maintenance and at most 5 concurrent indexing jobs, configurable in the native component configuration. Each index retains its own maintenance controls. Only checkpoints advance coverage; reading refreshes observations without organizing. The UI controls heartbeat cadence, per-index maintenance and task recovery. There is no automatic Feishu authorization or historical import.

## Index sources and navigation

`MemoryIndexAddSources` appends IDs from `MemorySources` to one or more existing indexes in one transaction. It preserves documents, references, coverage, grouping and maintenance settings. Actual additions require idle group workers and no unfinished range on each changed index. Repeated additions are no-ops. Reading refreshes observations; `MemoryIndexMaintain` organizes the new history through the existing Agent. Only its checkpoint advances coverage.

Index reads expose shared usage guidance. `MemoryIndexContent` defaults to directory navigation; `key`, `keys` and `view=full` read bodies. `MemoryIndexLinks` navigates saved references to originals and accessible related entries, preserving exact versions and paginating expanded paths. Its shared-object count is not a recommendation score. It neither retrieves remote bodies nor runs maintenance.

## Proactive instructions

Heartbeats always use `PROACTIVE_TASK` from code. `InitiativeEnable` configures cadence only; there is no custom prompt setting. New bindings do not save instructions, and recovery removes the obsolete `state.instructions` field while preserving the conversation and scheduling state. After updating and restarting the Host, existing bindings use the current product prompt automatically. The ordinary chat role and heartbeat scheduler are unchanged.

## Verification

Run `npm run build --workspace @maka/runtime-host`, `npm run test:assistant --workspace @maka/runtime-host`, and the native service/platform tests in `dist/__tests__`. The behavioral tests now start the native service directly. Their external-source test still installs the real Feishu source plugin. Mock models are used; no paid model test is started. The assistant suite is also part of the Host's normal `test:dist` command.
