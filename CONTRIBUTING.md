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

# Contributing to Maka

[简体中文](CONTRIBUTING.zh-CN.md)

Use [issues](https://github.com/apache/maka/issues) for bugs and concrete proposals, and [Discussions](https://github.com/apache/maka/discussions) for questions. Report vulnerabilities through [SECURITY.md](SECURITY.md). Comment exactly `take` to claim an unassigned issue, or `untake` to release it.

Discuss project direction, governance and material product decisions on [dev@maka.apache.org](https://lists.apache.org/list.html?dev@maka.apache.org). Implementation details can be discussed in the pull request.

## Develop

Install Rust stable, Node.js 26, npm 12.2.1, just, cargo-nextest and Python 3. License checks also use cargo-deny. On Windows, put Git for Windows' `sh` on `PATH`.

```sh
just setup
just run --help
just check
```

`just check` runs formatting, lint, type checks, tests and license checks. For a focused Rust change, use `cargo nextest run -p CRATE`; `--lib` or `--test NAME` limits which test targets are built. Run the checks relevant to the changed behavior before the full repository check.

The [product guide](products/maka/README.md) explains TypeScript development. The [plugin guide](plugins/README.md) covers declarations and composition. Native packaging and V8 requirements live in [scripts/rust](scripts/rust/README.md). The [website](website/README.md) has a separate manifest and lockfile.

## Code and documentation

- Use `name.rs` with `name/` for child modules. Keep unit tests with their implementation and integration tests under `tests/`.
- Test observable behavior and meaningful failure boundaries. Avoid duplicate fixtures, source-text assertions and fixed sleeps.
- Keep domain policy in plugins. Host owns admission and resource settlement; services receive explicit capabilities.
- Model closed states with types and generate schemas with `schemars`. Put database changes in SQLx migrations.
- Keep protocol fields separate from localized copy. Preserve full `en`, `zh-CN` and `zh-TW` locale tags.
- Maintain concise English and Chinese README counterparts. Explain responsibilities and useful entrypoints; link to schemas for field-level detail.

## Submit and review

Use Conventional Commit titles and `<type>/<description>` branches. Fill in the [pull request template](.github/pull_request_template.md), describe the result and relevant verification, and include screenshots or a recording for UI changes. Squash merging makes the PR title the final commit title.

Each contribution has a human owner responsible for its accuracy, provenance and licensing. Submit only work you have the right to contribute, under [Apache-2.0](LICENSE), and preserve third-party attribution. See the [source records](docs/code-origin-audit.md) and [header policy](.github/ASF_SOURCE_HEADERS.md).

Disclose substantive generative-tool use in the PR and name the tool. Translation, wording edits, autocomplete and spelling correction do not count. Material AI-authored commits carry `Generated-by: <tool>`, preserved through squash or amend. Automated messages identify themselves.

Agents may commit and push. Merging to `main` requires approval from another committer and a passing `test` check. AI review does not replace independent human judgment. Approval remains valid after later pushes; ask for another look when the change grows beyond what was reviewed. A maintainer decides whether the review is sufficient.
