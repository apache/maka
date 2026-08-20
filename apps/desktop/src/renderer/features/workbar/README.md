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

# Workbar feature

Workbar is a vertical renderer feature. Its application-level model owns the
right/bottom panel topology, active tabs, dimensions and persisted collapse
state. Tool data remains session-scoped, and the session content surface is
remounted when the active session changes.

## Dependency direction

- Consumers import production APIs from `features/workbar`.
- Tests and stories may additionally import `features/workbar/testing`.
- Workbar may use shared renderer primitives, core types and Maka UI.
- Workbar must not import shell composition, Desktop bridge, or main-process implementation.
- Desktop I/O enters through `WorkbarServices`; tool code does not read
  the Desktop global bridge directly.

## Lifecycle invariants

- Review, Tasks, Browser, Files and Inspector tabs are persisted globally.
- Terminal and Side Chat tabs, preview state and resource metadata are
  transient.
- `WORKBAR_TOOL_DEFINITIONS` is the authority for persistence, singleton
  behavior and default placement; storage and controller code consume it
  rather than maintaining parallel kind lists.
- Closing or leaving the owner session stops Terminal resources.
- Side Chat survives panel collapse and is cleaned only when its tab closes or
  when navigation leaves its source session.
- Inactive tabs stay mounted; their hooks receive the existing active/hidden
  signal and decide whether to subscribe.

## Adding a tool

Add its metadata, define the smallest service port it needs, implement its hook
and surface under `tools/`, register fake-service story states, and pin both its
state transitions and resource cleanup in tests.
