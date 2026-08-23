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

# AGENTS.md

Orientation for coding agents working in this repository.

**This file points; it does not restate.** Setup, the package map, contribution policy, and
architecture have owners elsewhere; duplicating them here would create a second source of truth
that silently goes stale. What stays below is the short list of things an agent gets wrong that no
document currently warns about. Wanting to add a fact that lives somewhere else means adding the
link instead — and if you change something described here, update it in the same change.

Maka reads this file itself — `buildWorkspaceInstructionsPromptFragment` injects the nearest
`AGENTS.md`, `CLAUDE.md`, or `GEMINI.md` into the system prompt — so it is live product input, not
only documentation. It is also truncated past 6000 characters, which is the hard reason to keep it
short.

## Where things are written down

| Question | Read |
|---|---|
| What is this project, how do I install and run it | [README.md](./README.md) |
| How do I contribute, branch, title a PR, disclose AI use | [CONTRIBUTING.md](./CONTRIBUTING.md) |
| How is the runtime designed | [ARCHITECTURE.md](./ARCHITECTURE.md), then [`docs/architecture/`](./docs/architecture/) |
| What must pass before merge | [`.github/workflows/ci.yml`](./.github/workflows/ci.yml) — the authoritative gate list |
| What are the lint and format rules | [`biome.jsonc`](./biome.jsonc) |
| What commands exist | `package.json` `scripts`, at the root and per workspace |

Two invariants from those documents change how you read the code:

- **Runtime Host is the only execution authority.** Desktop, TUI, CLI, and eval all execute through
  it. A change that seems to need its own runtime is a design discussion, not an implementation
  detail.
- **The Runtime Event Log is the source of truth**, and sessions, UI, model context, and recovery
  are projections over it. Context pruning and compaction change what the next inference sees; they
  never delete recorded evidence. If a fix tempts you to rewrite recorded events, the intended
  mechanism is a projection instead.

## Tests run from `dist/`, not `src/`

This is the one that costs the most time, because it fails silently.

Every workspace compiles TypeScript to `dist/` and runs `node --test` against the **compiled
output**. Editing a `.ts` file and re-running a test suite will re-test the previous build, with no
error to tell you.

```sh
npm --workspace @maka/runtime run build          # then, and only then:
npm exec -w @maka/runtime -- node --test "dist/__tests__/some-file.test.js"
```

The root `npm test` and each workspace's `npm test` handle this for you by building first; the fast
iteration loop above does not. Consequences:

- Never edit anything under `dist/` — it is build output.
- After changing a package others depend on (`core`, `storage`, `runtime`), rebuild it before
  testing its dependents, or you will debug stale behaviour.

## Traps that are only recorded in code

- **Biome formats the tree except `apps/desktop/**` and `packages/ui/**`**, which are linted but not
  formatted. Desktop ships source-contract tests that read `.ts`/`.tsx` source and regex-match exact
  single-line shapes, so reformatting breaks them. The reasoning is in the `formatter.includes`
  comment in [`biome.jsonc`](./biome.jsonc); do not reformat those paths by hand either.
- **Some files are generated.** They match `*.generated.ts`; regenerate rather than hand-edit.
- **Every source file needs the ASF license header.** `npm run check:asf-headers` audits the whole
  checkout, so stray untracked files can fail it. `node scripts/asf-license-headers.mjs write` adds
  missing headers.
- **`ripgrep` must be installed** — the runtime's `Grep` tool shells out to `rg`.

## Working method

1. **Read the architecture doc for the area first.** Runtime behaviour is rarely local; a change in
   `packages/runtime` usually has a projection, a recovery path, and a Host protocol consequence.
2. **Reproduce before fixing.** Write a failing test that demonstrates the defect, then fix it.
3. **Prove the test bites.** Re-run it against a build without your fix and confirm it goes red. For
   a test guarding *new* behaviour, check it against a plausible weaker version of the fix — a test
   that passes either way is not a guard.
4. **Watch for vacuous tests.** Several suites run against a fake backend rather than a real
   provider. A fake can be more cooperative than production code, so a green suite is not by itself
   evidence that the real path works. If a fake compensates for something, say so.
5. **Characterise pre-existing failures.** Before reporting a failing suite as pre-existing, run it
   against a clean checkout of the base branch, and say which suites you did not run.
6. **Match the surrounding code.** This codebase comments the *why*, and often records the bug a
   design choice prevents. When you change such code, update the reasoning rather than deleting it.
