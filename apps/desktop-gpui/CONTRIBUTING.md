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

# Contributing

Read the repository root's `CONTRIBUTING.md`, then `AGENTS.md` in this
directory. `AGENTS.md` holds the engineering rules this client enforces:
layout, gpui-kit usage, performance, accessibility, protocol discipline, and
verification.

## Before opening a pull request

- `just check` passes: format check, Clippy with `-D warnings`, and tests.
- If you changed the protocol crate, `just drift` passes.
- If you changed anything visible, you ran the app against a real dev Host and
  exercised the change with both mouse and keyboard.
- New dependencies pass `just deny`.

## Commits and pull request descriptions

Follow the repository root's `CONTRIBUTING.md`: Conventional Commits titles
(scope `desktop-gpui`), and its rules for stating which generative tools
contributed. You are responsible for reviewing and testing all generated
code.

## Licensing

Contributions are accepted under Apache-2.0. Do not copy code from GPL or AGPL
projects, including egoist/waku and Zed's application crates.
