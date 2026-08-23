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

# Code origin audit

**Historical scan baseline:** `1518442865763d603571f5d77c13ffc3b0c96125` (2026-08-11)
**Evidence reconstruction:** 2026-08-12
**Report status:** complete for the recovered scan results; bootstrap tooling confirmation remains open

## Outcome

The recovered historical scan surfaced no GPL, AGPL, commercial, or unknown-license candidate. One candidate is source-available (entry 23, `MIT + Commons Clause`); it was examined separately and Maka takes no material from it. Of 417 files with SCANOSS results, 392 matched Maka repositories and 25 matched other projects. Manual review classified 22 of the 25 external candidates as common or structurally necessary short code and three as real third-party lineage with an incorrect or incomplete scanner attribution:

- the generated Astryx theme and ejected Astryx `ChatReasoning` component are MIT-licensed Meta material;
- Maka's model protocol types are adapted from the Apache-2.0 AI SDK packages `@ai-sdk/provider-utils` and `@ai-sdk/provider`, not from the `talkio` package selected by the scanner.

This audit adds Astryx and the AI SDK adaptation to the top-level `LICENSE`. `NOTICE` does not change: the fixed Astryx and AI SDK sources contain no upstream `NOTICE`, and their license notices are carried in `LICENSE` or in the source file. The 22 incidental matches do not add third-party material or attribution obligations.

This is bounded evidence, not proof that every line is original. Results depend on the fixed source snapshot, SCANOSS knowledge base, scanner thresholds, supported file types, and human classification.

## Scope and tools

The baseline contains 2,545 tracked files. The historical investigation used:

| Tool | Version | Scope | Data behavior | Preserved result |
|---|---:|---|---|---|
| ScanCode Toolkit | 32.5.0 | 2,542 tracked files; local license, copyright, and package analysis | Local only | The raw result expired; the contemporaneous count and conclusion are retained here |
| SCANOSS JS CLI | 0.40.2 | 2,231 files supported by its winnowing scanner | The public API received winnowing fingerprints with obfuscated file identifiers; it did not receive source files or repository-relative paths | The 2,231-file JSON and WFP were recovered locally and used to reconstruct the table below |
| FOSSA CLI | 3.17.16 (`d693e0d6f44d`) | Static npm dependency analysis | Local static mode; no FOSSA project or cloud snippet scan | One npm project succeeded with no analysis warning |

The SCANOSS response identifies server `5.4.25` and knowledge bases `26.07` (monthly) and `26.08.10` (daily). Markdown, images, and other unsupported formats did not receive SCANOSS fingerprints. They were handled separately under [Other provenance evidence](#other-provenance-evidence).

The recovered JSON and WFP were working files and were not retained; they are not present on the machine that produced this report, and no hash or byte size of them was recorded before they were lost. This table therefore cannot be verified byte-for-byte against the artifacts it came from. What can be re-checked independently is each conclusion: every row names the upstream candidate, and the rows that drive a `LICENSE` or `NOTICE` decision carry their own reproduction path — see [Model protocol adaptation](#model-protocol-adaptation) for entry 17 and the git revisions cited in entry 23. A future scan should write its JSON and WFP to a retained location and record their SHA-256 and size in the report before any conclusion depends on them.

No new fingerprint or source upload was performed while reconstructing this report.

### Reproduction

The original shell transcript was not retained. The following commands reconstruct the fixed snapshot and the scanner configuration represented by the recovered artifacts; a new API response can differ as the knowledge base changes:

```sh
AUDIT_SNAPSHOT="$(mktemp -d)"
git archive 1518442865763d603571f5d77c13ffc3b0c96125 | tar -x -C "$AUDIT_SNAPSHOT"
npx --yes --package scanoss@0.40.2 scanoss-js wfp --obfuscate -o scan.wfp "$AUDIT_SNAPSHOT"
npx --yes --package scanoss@0.40.2 scanoss-js scan --wfp --obfuscate -o result.json scan.wfp
```

The final command sends fingerprints to the CLI's public default endpoint. Obtain project approval before running it. To reproduce only the local fingerprint set, stop after the `wfp` command. Compare results by source content hash rather than obfuscated filename because each obfuscated run may assign different identifiers.

The FOSSA run was constrained to static analysis. It detected the npm project successfully, but it did not perform snippet provenance analysis and therefore does not corroborate or replace the SCANOSS results.

## SCANOSS result reconstruction

The recovered result has 2,231 keys:

- 1,814 returned no match;
- 367 matched `maka-agent/maka-agent`;
- 25 matched `jackwener/maka-agent`, a Maka fork;
- 25 matched projects outside Maka.

The WFP records the MD5 content hash and an obfuscated filename for every scanned file. Hashing the fixed Git snapshot mapped all 2,231 identifiers back to exactly one repository path; no key was unmapped. The table records the scanner's best candidate. “Common snippet” means that the matched text is a routine API shape, type declaration, test scaffold, or build boilerplate and that the candidate does not explain the local file's provenance. A percentage is the scanner's reported coverage, not an authorship probability.

Several rows note that the matched file is absent from current `main`. That is a supplementary fact, not a disposition: the repository history is published too, so each row is classified on the matched text itself rather than on whether the file survives in the release snapshot. Candidate license fields are the scanner's, and entry 23 shows they can be wrong; any candidate whose license affects a `LICENSE` or `NOTICE` conclusion was re-checked against the upstream license file.

| # | Maka file and lines | SCANOSS candidate | Match | Classification and disposition |
|---:|---|---|---:|---|
| 1 | `apps/desktop/src/main/__tests__/renderer-core-barrel-node-boundary.test.ts:30-52` | [`muratgur/ordinus`](https://github.com/muratgur/ordinus) v0.1.0, `app/src/main/runtime/cli/process.ts:6-28` (MIT) | 33% | Common child-process Promise scaffold; no distinctive shared implementation. No attribution. File is absent from current `main`. |
| 2 | `apps/desktop/e2e/new-task-reload.spec.ts:11-18` | [`clickety-clacks/clawline`](https://github.com/clickety-clacks/clawline) `dictation-working-2026-05-12`, `playwright/tests/phase3-stream-management.spec.ts:348-355` (BSD-3-Clause) | 36% | Common Playwright click/fill/reload/expect sequence. No attribution. |
| 3 | `apps/desktop/src/main/os-permission-policy.ts:6-11` | [`jasonzh0/CineScreen`](https://github.com/jasonzh0/CineScreen) v1.3.4, `src/platform/mac/permissions.ts:43-48` (MIT) | 7% | Necessary mapping of Electron permission literals. No distinctive expression. No attribution. |
| 4 | `apps/desktop/src/main/session-model-input.ts:10-17` | [`enisz/bitbutler`](https://github.com/enisz/bitbutler) v1.2.0, `packages/electron/src/ipc/server.ts:204-211` (MIT) | 35% | Common object narrowing and required-string validation. No attribution. |
| 5 | `apps/desktop/src/renderer/astryx-theme/maka.js:14-195` | [`@astryxdesign/theme-neutral`](https://www.npmjs.com/package/@astryxdesign/theme-neutral/v/0.1.0-canary.7847c5f) 0.1.0-canary.7847c5f, `dist/neutral.js:11-192` (MIT) | 92% | **True third-party lineage.** Generated by the pinned Astryx CLI from `makaTheme.ts`, which extends `theme-neutral`. Covered by the new Astryx entry in `LICENSE`; generated header retained. |
| 6 | `apps/desktop/src/renderer/astryx-theme-mode.ts:33-38` | [`kmcom-nuxt-layers`](https://www.npmjs.com/package/kmcom-nuxt-layers/v/1.6.11) 1.6.11, `layers/shader/app/composables/useCSSColourUniform.ts:33-38` (ISC) | 13% | Common `MutationObserver` setup and cleanup. No attribution. |
| 7 | `apps/desktop/src/renderer/use-system-ui-locale.ts:15-20` | [`@shak-hooks/cli`](https://www.npmjs.com/package/@shak-hooks/cli/v/1.0.0) 1.0.0, `templates/react/usePreferredLanguage.ts:16-21` (license not returned) | 25% | Common browser language/media-query hook fragment. The candidate does not establish copying; no attribution. |
| 8 | `packages/cli/src/session-driver-policy.ts:16-23` | [`pi-telegram-plus`](https://www.npmjs.com/package/pi-telegram-plus/v/0.0.1) 0.0.1, `lib/commands/session.ts:27-34` (MIT) | 10% | Conventional quote stripping and home-directory expansion. No attribution. |
| 9 | `packages/computer-use/src/abortable-delay.ts:17-30` | [`@hashline/sdk`](https://www.npmjs.com/package/@hashline/sdk/v/0.1.0) 0.1.0, `src/retry.ts:61-74` (Apache-2.0) | 43% | Conventional abortable timeout Promise. No distinctive shared expression. No attribution. |
| 10 | `packages/computer-use/src/stdio-json-rpc.ts:23-29` | [`stefanhoelzl/codehydra`](https://github.com/stefanhoelzl/codehydra) `code-server-windows-v4.107.1`, `extensions/markdown-review-editor/src/extension/opencode-handler.ts:44-50` (MIT) | 8% | Conventional `AbortSignal` Promise wrapper. No attribution. |
| 11 | `packages/core/src/mcp.ts:78-86` | [`@combycode/llm-sdk`](https://www.npmjs.com/package/@combycode/llm-sdk/v/1.0.0) 1.0.0, `dist/plugins/mcp/types.d.ts:29-37` (MIT) | 7% | Protocol-shaped discriminated unions dictated by MCP content kinds. No attribution to the scanner candidate. |
| 12 | `packages/runtime/scripts/build-filesystem-worker.mjs:4-12` | [`zhongshi2x8/dust2cc`](https://github.com/zhongshi2x8/dust2cc) v1.1.1, `scripts/build-page-script.mjs:4-12` (MIT) | 42% | Standard `esbuild` entry/output setup. No distinctive shared implementation. No attribution. |
| 13 | `packages/mcp/src/__tests__/tool-output-validation.test.ts:4-28` | [`modelcontextprotocol/conformance`](https://github.com/modelcontextprotocol/conformance) `32523cc`, `examples/servers/typescript/everything-server.ts:33-57` (MIT/Apache-2.0) | 51% | MCP schema fixture using standard `inputSchema`/`outputSchema` fields. Local assertions and purpose differ. No copied fixture identified. |
| 14 | `packages/core/src/user-question.ts:7-19` | [`baochipham942-eng/code-agent`](https://github.com/baochipham942-eng/code-agent) v0.2.4, `src/shared/types.ts:489-501` (MIT) | 50% | Short structural types for questions, IDs, and answers. No distinctive shared expression. No attribution. |
| 15 | `packages/eval/src/__tests__/fixtures/writer-worker.ts:3-22` | [`agent-awareness`](https://www.npmjs.com/package/agent-awareness/v/0.4.5) 0.4.5, `src/commands/codex-hooks.ts:10-29` (MIT) | 86% | Small concurrency-test worker composed of standard file markers, a polling loop, and exit status. Candidate purpose and identifiers differ. No attribution. File is absent from current `main`. |
| 16 | `packages/runtime/src/http-response.ts:9-14` | [`different-ai/openwork`](https://github.com/different-ai/openwork) `alpha-macos-v0.14.1-alpha.982-1aeb1e4`, `apps/server/src/server.ts:869-874` (MIT) | 35% | Necessary Fetch API reconstruction after deleting encoding/length headers. No distinctive expression. No attribution. |
| 17 | `packages/runtime/src/model-protocol.ts:89-106,123-142,211-227,275-290` | [`talkio`](https://www.npmjs.com/package/talkio/v/1.0.0-alpha.1) 1.0.0-alpha.1, `src/types/common.ts:16-33,23-42,72-88,104-119` (Apache-2.0) | 14% | **Real third-party lineage, wrong candidate.** The source is the Apache-2.0 AI SDK, not `talkio`; see [Model protocol adaptation](#model-protocol-adaptation). Both AI SDK packages are now named in `LICENSE` and the file carries an Apache-2.0 §4(b) modification notice. |
| 18 | `packages/storage/src/__tests__/package-import.test.ts:5-14` | [`openbroker`](https://www.npmjs.com/package/openbroker/v/1.9.5) 1.9.5, `scripts/setup/package-catalog.test.ts:4-13` (MIT) | 64% | Conventional `spawnSync` import-isolation test. No distinctive shared expression. No attribution. File is absent from current `main`. |
| 19 | `packages/ui/src/__tests__/input-history.test.ts:14-46` | [`erichgschmidt/colorsmash`](https://github.com/erichgschmidt/colorsmash) `v2-preview-6559730`, `ColorSmash-v2/src/core/prefs.test.ts:7-39` (MIT) | 24% | Minimal implementation of the standard Web Storage interface. No distinctive shared expression. No attribution. File is absent from current `main`. |
| 20 | `packages/ui/src/astryx-chat-reasoning.tsx:37-73` | [`@astryxdesign/lab`](https://www.npmjs.com/package/@astryxdesign/lab/v/0.1.2-canary.3f9afb0) 0.1.2-canary.3f9afb0, `src/ChatReasoning/ChatReasoning.tsx:181-217` (MIT) | 24% | **True third-party lineage.** The complete file already identifies the ejected Astryx v0.1.9 component, fixed commit, Meta copyright, MIT SPDX identifier, and local modifications. Covered by the new Astryx entry in `LICENSE`. |
| 21 | `packages/ui/src/inline-rename-input.tsx:9-21` | [`695714420/ClaudeCodeIDE`](https://github.com/695714420/ClaudeCodeIDE) 1.3.0, `src/renderer/components/FileExplorer.tsx:481-493` (license not returned) | 25% | Short React prop declaration plus focus/select effect. The candidate does not establish copying; no attribution. |
| 22 | `scripts/cu-physical-input-age.swift:8-16` | [`jianzhoujz/input-indicator`](https://github.com/jianzhoujz/input-indicator) v1.1.0, `Sources/DoubaoInputIndicator.swift:352-360` (MIT) | 42% | Enumeration of the public CoreGraphics input event cases needed by the API. No distinctive expression. File is absent from current `main`. |
| 23 | `packages/ui/src/utils.ts:all` | [`roseratugo/okarin`](https://github.com/roseratugo/okarin) v0.3.13, `apps/desktop/src/lib/utils.ts:all` (`MIT + Commons Clause`; the scanner reported `MIT/Mackerras acknowledgement`) | 100% | **Byte-identical, independently arrived at.** Maka's file is a five-line `clsx` wrapper whose lineage is recorded in this repository: `3bedf3341` created it as the shadcn `cn` helper with `twMerge`, and `51f04793c` (#1853) removed `twMerge` when the Astryx migration dropped Tailwind, leaving the current form. No upstream material was taken, so no attribution is required and the Commons Clause restriction reaches nothing in Maka. |
| 24 | `scripts/apply-dependency-patches.mjs:17-22` | [`walkersutton/cyclemetry`](https://github.com/walkersutton/cyclemetry) v0.2.0, `scripts/release.mjs:4-9` (MIT) | 12% | Standard ESM `fileURLToPath` repository-root calculation. No attribution. |
| 25 | `scripts/check-astryx-alignment.test.mjs:5-10` | [`naimkatiman/continuous-improvement`](https://github.com/naimkatiman/continuous-improvement) v3.9.1, `test/backfill.test.mjs:10-15` (MIT) | 25% | Standard Node test imports and `new URL('..', import.meta.url)` root calculation. No attribution. File is absent from current `main`. |

## Model protocol adaptation

Entry 17 was re-examined directly against upstream source rather than against the scanner candidate. The finding is that `packages/runtime/src/model-protocol.ts` adapts AI SDK material and that the first revision of this report overstated what the file itself disclosed: the file's header claimed only that its shapes were "structurally equivalent" and "Maka-owned", and named neither a source version nor the adaptation.

The adaptation is established by more than shape equivalence:

- The `ProviderReference` doc comment reproduces the upstream `SharedV4ProviderReference` comment near-verbatim, including its explanation of the `type?: never` constraint and its two examples, with only the type name changed.
- `JSONValue`, `JSONObject`, and `JSONArray` match upstream exactly, including the union order and the `| undefined` index signature.
- Field order matches upstream member for member, including an upstream inconsistency: `FilePart` orders `data, filename, mediaType` while the tool-result `file` variant orders `data, mediaType, filename`. Both orderings are reproduced.
- Union member order matches, including arbitrary sequences such as `CustomPart` appearing second in `AssistantContent`.
- The upstream choice of `interface` versus `type` is reproduced per declaration. `ToolApprovalRequest` and `ToolApprovalResponse` are the only content-part shapes declared as `type` in the Maka file, matching upstream.

Maka's modifications are the removal of the deprecated `file-*` and `image-*` tool-result content variants, extraction of the inline tool-result content union into `ToolResultContentPart`, inlining of the shared provider aliases, and declaration of the role message shapes as interfaces. Roughly 170 of the file's 418 lines — the tool definition, usage, finish reason, failure, request metadata, and stream contracts — are Maka-authored with no upstream counterpart.

The material spans two packages. `JSONValue` and the `SharedV4` provider option, provider reference, and file data shapes come from `@ai-sdk/provider`, not from `@ai-sdk/provider-utils`. The first revision of this report named only `provider-utils`; `LICENSE` now names both.

The versions pinned in `LICENSE` are those installed when the adaptation was made in `3249f2a0ec2b389efcd935078c6c835c31195e88` (#1381 slice 1, 2026-07-23): `@ai-sdk/provider-utils@5.0.11` and `@ai-sdk/provider@4.0.3`. The audit baseline snapshot resolved `5.0.25` and `4.0.7`; every adapted declaration is byte-identical across those version ranges, so the two pinnings identify the same source material. Reproduce with:

```sh
npm pack @ai-sdk/provider-utils@5.0.11 @ai-sdk/provider@4.0.3
```

and compare `package/src/types/`, `package/src/json-value/`, and `package/src/shared/v4/` against the module.

The file now carries the Apache-2.0 §4(b) modification notice that this lineage requires. Adding the component to `LICENSE` alone did not satisfy that obligation.

## LICENSE and NOTICE review

The top-level `LICENSE` now accounts for source material that is directly included or adapted in Maka:

- Apache-2.0 [`@ai-sdk/provider-utils@5.0.11`](https://www.npmjs.com/package/@ai-sdk/provider-utils/v/5.0.11) and [`@ai-sdk/provider@4.0.3`](https://www.npmjs.com/package/@ai-sdk/provider/v/4.0.3), from which `packages/runtime/src/model-protocol.ts` adapts provider-boundary shapes;
- MIT Astryx at `c9fe4379e9959b9ba5eeff56def34c752223450e` for the ejected `ChatReasoning` source and `110987b4505dc44119b94bed53d92b9840088a61` for theme-neutral v0.4.0 and its generated theme material;
- MIT `trycua/cua` at `8c921b2b3bf13494724ead4f0a814d80c56a7e8b`, already recorded by pull request #2676.

The desktop binary distribution also carries generated production npm notices at `apps/desktop/resources/licenses/npm/THIRD_PARTY_NOTICES.txt`, and the build checks that artifact byte-for-byte.

The audit also corrected the notice generator's version-pinned Apache override. It previously read the entire top-level `LICENSE`; once that file acquired third-party appendices, those unrelated appendices were copied into the `@ai-sdk/provider-utils` package section and the checked artifact became stale. The override now extracts only the standard Apache-2.0 portion, with a focused regression test.

No `NOTICE` addition is warranted. The fixed Astryx and `trycua/cua` revisions have no upstream `NOTICE`; neither AI SDK package has an upstream `NOTICE`; and MIT copyright notices already preserved in `LICENSE` or source should not be duplicated into `NOTICE`. This follows ASF guidance to keep `NOTICE` limited to legally required notices and to make `LICENSE`/`NOTICE` reflect only bundled bits.

## Other provenance evidence

The SCANOSS table above covers only what its winnowing scanner fingerprints, which is source code in supported formats. Two further categories of incoming material were found outside it and are recorded here. Both are attribution gaps rather than license conflicts, and both are tracked for the release legal-files gate in #3270; neither is resolved by this report.

### Adapted opencode source

`packages/runtime/src/tool-output.ts` and `packages/runtime/src/edit-replace.ts` each state in a header comment that they are adapted from opencode. Both statements are accurate and the adaptation is substantial:

- `truncateToolOutput` follows `truncate.output()` line for line, sharing the `2000`-line and `50 KiB` budgets, the `direction?: 'head' | 'tail'` option, the local names `out`, `bytes`, `hitBytes`, `size`, `preview`, `removed`, and `unit`, and the asymmetric newline accounting that uses `(i > 0 ? 1 : 0)` when keeping the head and `(out.length > 0 ? 1 : 0)` when keeping the tail. Maka added byte-safe single-line slicing, trailing-newline handling, and the recovery hint, and dropped the upstream spill-file machinery.
- `edit-replace.ts` reuses the escape-normalizing replacer verbatim at the level of expression: the regular expression `/\\(n|t|r|'|"|`|\\|\n|\$)/g` is character-for-character identical and its nine branches appear in the same order, rewritten from a `switch` into an `if` chain. The line-trimmed and whitespace-normalized matchers follow the same upstream structure.

Upstream is MIT, Copyright (c) 2025 opencode. The repository now resolves to `anomalyco/opencode`; the comparison used commit `fc80874`. Because opencode is not an npm dependency, `scripts/generate-third-party-notices.mjs` cannot reach it: that generator walks the npm production dependency trees of `@maka/desktop` and `maka-agent` only. "opencode" therefore appears in neither `LICENSE`, `NOTICE`, `packages/cli/THIRD_PARTY_NOTICES.txt`, nor the desktop notices, while both files ship in `@maka/runtime`. MIT requires the copyright and permission notice to travel with the material, so this is an open attribution obligation.

### models.dev data snapshot

`packages/core/src/model-metadata.generated.ts` and `packages/runtime/src/telemetry/model-pricing.generated.ts` are checked-in, shipped derivations of `https://models.dev/api.json`, together about 27,800 lines. Upstream `sst/models.dev` is MIT, Copyright (c) 2025 models.dev. The individual entries are facts and are not themselves copyrightable, but the selection and arrangement — which providers and fields are carried, and upstream's normalized structures such as `lifecycle` and `thinkingOptions.efforts` — come from that database. The same generator boundary applies: models.dev is not an npm dependency, and it appears in none of the four attribution surfaces. The generated headers also record no snapshot date or upstream revision, so the fixed source cannot currently be identified.

### Bundled Skills

Pull request #2695 removed the 29 bundled Skills whose individual origins could not be confirmed. The retained `computer-use` Skill has a contributor-confirmed, independently reviewed origin record in `packages/runtime/resources/bundled-skills/provenance.json`. The final human approval on pull request #2676 reviewed commit `3c7683b9793e97cba7d8536f6864da0e38f24c30`. That review covers the Skill origin record; it does not make a legal or ASF release determination about implementation inputs.

### Computer Use implementation inputs

Pull requests #1255 and #1883 and the contributor's confirmation on pull request #2676 state that a fixed signed `SkyComputerUseService` binary was statically inspected and that specific cursor geometry, motion values, thresholds, path-measurement choices, and core scoring weights were recovered and retained. The repository contains neither OpenAI source nor executable bytes. This is a narrow statement about the listed facts, not a classification of the Computer Use implementation as a whole as binary-derived.

The exact boundary, locally authored divergences, and artifact reproducibility limit are recorded in `docs/computer-use-cursor-provenance.md`. Whether the applicable agreement and law permit retaining those listed facts remains a human legal/ASF question. The provenance review does not answer it.

### Generated images

A maintainer confirmed that the following assets were AI-generated and that no third-party image, logo, or artwork was uploaded as input:

- `.github/assets/maka-hero.en.png`
- `.github/assets/maka-hero.zh-CN.png`
- `apps/desktop/assets/icon.png`
- `apps/desktop/resources/status/cu-status.png`
- `apps/desktop/resources/status/cu-status@2x.png`

The first three used ChatGPT Image. The status PNGs were exported from an AI-generated SVG. Exact prompts were not retained and may have requested a visual style reference, so this confirmation is provenance evidence rather than a guarantee that no style or IP concern exists.

## Bootstrap generative tooling

The initial commit is `8fd91a43cc64cdde58cfbd046256effce0cfa6f8` (2026-05-19). The current contributor account is expected to confirm the bootstrap history. The working account is that Raft orchestrated Claude and Codex, but the repository does not establish:

- the exact Raft product or version;
- the exact Claude and Codex products or model versions;
- whether each tool was used through an individual, team, enterprise, API, or other agreement;
- the governing terms and dates for those accounts;
- whether any training-data similarity or provenance protection was enabled.

Until the contributor supplies that information, this item is `pending contributor confirmation`. It does not block publication of this evidence report, but it prevents the stronger conclusion that every bootstrap tool's applicable terms have been verified against ASF generative-tooling guidance.

## Policy boundary and remaining actions

ASF guidance permits AI-assisted contributions when the tool terms do not restrict output incompatibly with open source and any included third-party material is absent or used under a compatible license. Code scanning can provide reasonable evidence, but the ASF does not prescribe SCANOSS or FOSSA and a scanner result is not an originality certificate.

Before code transfer or release review:

1. obtain and record the bootstrap contributor confirmation;
2. obtain an appropriate human legal/ASF determination about retaining the specifically documented facts recovered through static inspection, or replace those facts and dependent code independently;
3. have the human contributor of record review this report, the 25 classifications, and the final `LICENSE`/`NOTICE` decision;
4. attribute the adapted opencode sources and the models.dev snapshot, and close the generator gap that hides them, under #3270.

No additional source-removal issue is indicated by the recovered scan. A recurring cloud snippet scan is not recommended until the project chooses a service, data policy, stable thresholds, and an owner for false-positive review. The local dependency-notice check remains the narrower, deterministic CI control for shipped npm dependencies.

That check has a structural blind spot worth stating plainly, because it produced both gaps in [Other provenance evidence](#other-provenance-evidence). `scripts/generate-third-party-notices.mjs` derives its inventory from npm production dependency trees, so material that enters the repository as vendored or adapted source, or as generated data, is invisible to it by construction — not missed by accident. Every such source must be registered by hand today, which means the next one will be missed the same way unless the generator gains a checked manual inventory.

The scanner has a comparable blind spot. Entry 17 was matched at 14% against an unrelated package, and what actually identified its origin was structural: near-verbatim doc comments, preserved declaration forms, and a reproduced upstream inconsistency. A follow-up sweep for the same pattern across the repository — comparing locally declared types against installed dependency declarations by name overlap and ordered property sequences — found no second instance. That sweep is still blind to a copy whose type and field names were renamed, and no comment, import, or architectural note suggests such a case exists.

## References

- [ASF Generative Tooling Guidance](https://www.apache.org/legal/generative-tooling.html)
- [ASF Treatment of Third-Party Works](https://www.apache.org/legal/src-headers.html#3party)
- [ASF LICENSE and NOTICE assembly guidance](https://infra.apache.org/licensing-howto.html)
- [Issue #2669](https://github.com/maka-agent/maka-agent/issues/2669)
- [Pull request #2695](https://github.com/maka-agent/maka-agent/pull/2695)
- [Pull request #2676](https://github.com/maka-agent/maka-agent/pull/2676)
- [Pull request #1255](https://github.com/maka-agent/maka-agent/pull/1255)
- [Pull request #1883](https://github.com/maka-agent/maka-agent/pull/1883)

## AI assistance disclosure

OpenAI Codex reconstructed the scan evidence, compared the fixed source snapshot with the recovered scanner output, and drafted this report and the accompanying attribution changes. The human contributor of record must review and own the classifications, accuracy, provenance, licensing, and submission decision.
