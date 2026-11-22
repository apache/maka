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

Use [Issues](https://github.com/apache/maka/issues) for bugs and concrete proposals, [Discussions](https://github.com/apache/maka/discussions) for open-ended questions, and [SECURITY.md](SECURITY.md) for private vulnerability reports. Comment `take` alone to claim an unassigned issue, or `untake` to release it.

Project direction, governance, and major product changes belong on [dev@maka.apache.org](https://lists.apache.org/list.html?dev@maka.apache.org). Implementation details can stay on the pull request.

## Local development

Install Rust stable, Node.js 24+ (CI uses 26), npm, `just`, `cargo-nextest`, `cargo-deny`, and Python 3. On Windows, ensure Git for Windows' `sh` is on `PATH`.

```sh
just setup
just run --help
just check
```

`just check` runs formatting, typechecks, tests, and license checks across the workspace. While iterating on a single Rust crate, run focused tests first:

```sh
cargo nextest run -p <crate> --lib
```

`just` and GitHub Actions share suite definitions in [`scripts/ci.mjs`](scripts/ci.mjs). See [scripts/rust](scripts/rust/README.md#ci) for change-plan inspection, V8 prebuilt caching, and native packaging. The [website](website/README.md) maintains its own `package.json` and lockfile.

## Engineering conventions

- Use `name.rs` + `name/` for submodules (avoid `mod.rs` in new code). Keep unit tests next to the implementation and integration tests under `tests/`.
- Test observable behavior and real failure boundaries—avoid brittle source-text assertions, redundant fixtures, and fixed sleeps.
- Validate inputs at system boundaries and trust typed internal contracts. Represent closed state machines with enums and derive wire schemas with `schemars`.
- Keep domain policy in plugins; the Host owns admission, capabilities, and resource cleanup.
- Evolve persisted state via forward, append-only `maka_event_log::migration::Migration` steps (locked by `scripts/rust/migrations.lock.json`). Rewrite old SQLite rows or JSON payloads in place inside a migration (`Migration::with_data`) rather than accumulating legacy read branches or external migration scripts; derived indexes (such as Recall/FTS) may be dropped and rebuilt. Update `products/maka/cli/tests/upgrade_compat.rs` whenever persisted features or formats change.
- Keep wire fields separate from UI copy, and maintain all three product locales (`en`, `zh-CN`, `zh-TW`) when adding UI strings.
- Write documentation only where it saves reader time. Keep maintained English and Chinese guides aligned, and link to types/schemas instead of duplicating field lists.

## Pull requests and provenance

Use Conventional Commit PR titles and `<type>/<description>` branch names. Because the repository squash-merges PRs, the PR title becomes the final commit subject. Fill out the [PR template](.github/pull_request_template.md) with verification evidence, and attach screenshots or recordings for UI changes.

Every contribution requires a human owner accountable for its correctness, provenance, and licensing under [Apache-2.0](LICENSE). Preserve third-party notices and review [source provenance](docs/code-origin-audit.md) and the [license header policy](.github/ASF_SOURCE_HEADERS.md) when adapting external code.

Disclose substantive AI assistance in the PR description (routine autocomplete, typo fixes, and translation polish do not require disclosure). Commits with material AI-authored code or prose must carry a `Generated-by: <tool>` trailer preserved through squash merge.

Agents may commit and push branches. Merging into protected branches requires passing CI checks and independent human committer approval.
