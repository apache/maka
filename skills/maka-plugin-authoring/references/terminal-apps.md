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

# Standalone SDK scene components

These components target the SDK scene runtime. Maka's terminal and desktop shells run their own workbench and do not mount these scenes.

An entry exports `activate(configuration)` with a Component descriptor:
`{ Counter: { contract, kind: "component", component: ["counter"] } }`.
The `counter` module export implements synchronous `mount`, `update`, `event` and
optional `capture` callbacks. Each callback returns actions/events and a frame with
`revision`, private JSON `state`, `surface` and platform-specific `view`.

Use the SDK's `Component<State, Props, TerminalNode>` and `ui.terminal`
constructors. Declare `{ name: "maka.tui.scene", version: 1 }` for the TUI entry.
The workbench is an NSH application, not written in this plugin component scene
language.

Native controls own editing, IME, selection, pointer capture, layout and scroll
measurement. Compose them through declared Component imports and stable child keys.
Do not mirror the full editor value into every frame. Capture an observed editor
revision and read its bounded text through the original Reader capability; an old
snapshot cannot authorize clearing a newer draft.

A frame action requests work after commit and receives a keyed action event.
Component callbacks themselves cannot await effects. Consume only replies for the
current request, owner and source. Hiding a panel can retain its original mount and
pending operation; rebuilding a root to close a dialog discards that continuity.

Component slots use the parent's explicit binding/member and checked `on` routes.
Native physical events arrive as `raw`; child component events retain `component`.
Return `decision: { preventDefault: true, stopPropagation: true }` only when the
accepted event is handled. Programmatic observations cannot acquire physical input
authority. Test focus, scrolling and closure through the actual native presenter.

`assets/starter/tui.mjs` is a complete minimal counter component.
For editors, forms and dialogs use the exact generated props and public contracts in
`references/sdk/contracts.ts` and `references/sdk/generated/runtime.ts`.
