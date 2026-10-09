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

# Architecture decision records

This directory records decisions that are expensive to reverse or that
constrain later work: crate boundaries, the Host protocol contract, major
dependencies, platform scope, and similar.

## Convention

- One decision per file, named `NNNN-short-kebab-title.md`. Numbers are
  sequential and never reused or renumbered.
- Each record has a title, a status line with a date, and three sections:
  Context, Decision, Consequences.
- Status is one of `Proposed`, `Accepted`, `Deprecated`, or
  `Superseded by NNNN`.
- Once a record is accepted, only its status line changes. To change a
  decision, write a new record that supersedes it and update the old record's
  status.
- Keep records short. Link to plans in `docs/plan/` and design notes in `docs/`
  for detail.

## Records

- [0001](0001-thin-client-over-runtime-host-protocol.md): Build a GPUI thin
  client over the Runtime Host protocol
