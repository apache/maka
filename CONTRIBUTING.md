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

[![docs](https://img.shields.io/badge/docs-%E7%AE%80%E4%BD%93%E4%B8%AD%E6%96%87-blue?logo=googletranslate&logoColor=white)](./CONTRIBUTING.zh-CN.md)

## Where to start

Bug fixes, model provider support, tests, performance work, and documentation merge most readily. Pick something up from [`help wanted`](https://github.com/maka-agent/maka-agent/issues?q=is%3Aissue+is%3Aopen+label%3A%22help+wanted%22) · [`good first issue`](https://github.com/maka-agent/maka-agent/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22) · [`bug`](https://github.com/maka-agent/maka-agent/issues?q=is%3Aissue+is%3Aopen+label%3Abug) · [`enhancement`](https://github.com/maka-agent/maka-agent/issues?q=is%3Aissue+is%3Aopen+label%3Aenhancement) and claim it in a comment. Use the **Bug report** or **Feature request** template for new issues; report security problems through [SECURITY.md](./SECURITY.md), never as a public issue. Questions, ideas, and not-yet-actionable proposals belong in [Discussions](https://github.com/maka-agent/maka-agent/discussions), which reaches the whole team by email.

Project direction, governance, and material product decisions are discussed publicly on [`dev@maka.apache.org`](https://lists.apache.org/list.html?dev@maka.apache.org) before implementation; implementation-level decisions may live in the pull request.

## Human ownership and AI attribution

Every contribution has a human contributor of record who reviews the work, decides to submit it, and owns its accuracy, provenance, and licensing. Agents may commit and push freely; the final review and merge decision always belongs to a human.

Each pull request states whether generative tooling contributed substantively, naming the tool if so; translation, wording edits, autocomplete, and spelling correction don't count. Automated messages must identify themselves. When AI authors a material part of a contribution, add a `Generated-by: <tool>` trailer to each affected commit, and keep it in the final commit through squash or amend.

## Review

Every pull request to `main` needs an approving review from a committer other than the author and a passing `test` check; branch protection in [`.asf.yaml`](./.asf.yaml) enforces both. An approval stays valid across later pushes — push follow-up commits in the open, and ask for another look when the change grows past what was reviewed. The review must be an independent human judgment — AI review does not count. A maintainer decides whether a change is material and whether the review it received is enough.

## Provenance and licensing

Submit only work you have the right to contribute, and record third-party sources, licenses, and attribution. Contributions are licensed under the [Apache License 2.0](./LICENSE); for material AI-generated content, follow the [ASF Generative Tooling Guidance](https://www.apache.org/legal/generative-tooling.html).

## Quick start

Requires Node `>=22.19.0` and npm `11.19.0` (root `package.json`); desktop work needs macOS Apple Silicon.

```sh
git clone https://github.com/maka-agent/maka-agent.git
cd maka-agent
npm install                 # root only — never inside a workspace
npm run build               # builds every workspace in dependency order
npm --workspace @maka/core test
```

## Developing Maka

```sh
npm run dev          # desktop app with HMR
npm run cli:dev      # TUI; `npm run cli:dev -- run "…"` runs one non-interactive turn
npm test             # all workspaces, or: npm --workspace @maka/core test
```

Building a single workspace only succeeds when its dependencies are already built — when unsure, build from the root. Tests run against compiled output in `dist/`; each workspace's `test` script cleans, builds, then runs `node --test`. Always go through it.

Before pushing, match CI locally:

```sh
npm run lint
npm run format:check
npm run build
npm run typecheck
npx knip --workspace apps/desktop
npx knip --workspace packages/ui
```

Architecture is documented in [ARCHITECTURE.md](./ARCHITECTURE.md); evaluation commands and contracts live in [`packages/eval`](./packages/eval).

## Pull requests

Opening a pull request pre-fills [`pull_request_template.md`](./.github/pull_request_template.md); fill it in rather than replacing it.

Branches and titles follow [Conventional Commits](https://www.conventionalcommits.org/): branches are `<type>/<description>`, titles are `<type>(<scope>): <summary>`. The repository squash-merges, so the title becomes the commit on `main`; `git log` shows the types and scopes in use.

For UI changes, include before/after screenshots or a recording. Keep the description short and your own — if it needs many paragraphs, the pull request is probably too large.
