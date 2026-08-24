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

# ASF source header policy

Apache Maka (Incubating) applies the [ASF source header policy](https://www.apache.org/legal/src-headers.html) to its source release and enforces it with an automated audit.

`scripts/asf-license-headers.mjs` is the policy. This document explains it; the script decides it. Where the two disagree, the script is authoritative and this document is the bug.

## What the audit asserts

The audit states two properties of the tree it is pointed at, and nothing else:

1. **Every entry is classified exactly once** — covered, excluded with a recorded reason, or an audit failure.
2. **In every covered file the ASF license text occurs exactly once**, and that occurrence is the canonical rendering at the top of the file.

Both are properties of the artifact. Neither is stated in terms of what `npm run write:asf-headers` produces, and that separation is deliberate: an audit defined as "the file starts with the bytes the writer emits" can only ever confirm its own writer. Such an audit accepts a second license block stacked on top of a first one it failed to recognize, because the block it just wrote is sitting at the top of the file.

```sh
npm run check:asf-headers          # audit; fails on anything unresolved
npm run check:asf-headers -- --report
npm run write:asf-headers          # insert the header where there is none
```

## Detection is loose, acceptance is strict

Finding the license text and accepting it are different questions, so they use different tests.

- **Detection** flattens comment punctuation and line wrapping away, then looks for the text. It finds a header written with `//`, in a JSDoc block, with `#`, inside an HTML comment, at any indentation, with an `https` license URL, or rewrapped into one paragraph.
- **Acceptance** is byte-exact: the canonical rendering, first in the file apart from a shebang, an HTML doctype, or Markdown front matter.

A covered file is therefore in one of four states, and only the first is one a program may act on:

| State | Meaning | What happens |
| --- | --- | --- |
| `absent` | no license text anywhere | `write` inserts the header |
| `canonical` | exactly one occurrence, canonical, at the top | passes |
| `unrecognized` | one occurrence, but not the canonical rendering at the top | audit fails; `write` refuses |
| `duplicated` | more than one occurrence | audit fails; `write` refuses |

`write` only ever inserts. Reconciling an existing header written in another form means deciding what someone else's rendering meant, and that is not a decision to make in a mechanical sweep.

## Where the audit runs

- **Every pull request**, over the checkout. This keeps new files from landing without a header.
- **`Prepare ASF source candidate`**, over the extracted `apache-maka-<version>-incubating-src.tar.gz`, before anything is installed or built into that tree. The release gate therefore reads the exact bytes a voter downloads.

In a checkout the audit reads the files a source release would carry: tracked files plus untracked files Git would not ignore, minus what `export-ignore` prunes from the archive. A new file is therefore audited before it is ever staged, while ignored local scratch files stay out of the gate. `.gitattributes` is asked directly rather than restated in a rule — `export-ignore` on a directory prunes the whole subtree, so every ancestor is queried too, since `git check-attr` does not inherit.

An extracted archive has no index, so **every entry on disk is audited and none is skipped by name**. A file inside a `dist/` or `release/` directory in a source candidate is not something to audit around — it is unclassified, and the gate says so. Nor is a path `export-ignore` should have pruned: finding one means it did not, so the audit reports it instead of excusing it with the reason that says it cannot be there. An entry that is neither a directory nor a regular file is reported rather than passed over.

Subtracting in a checkout is not the enumeration excusing itself. It decides which artifact the checkout stands in for; nothing is dropped from the archive, where the artifact is already fixed. The two modes therefore audit the same set of files.

## Covered file types

| Comment syntax | Extensions |
| --- | --- |
| `/* … */` | `.cjs`, `.css`, `.js`, `.mjs`, `.mts`, `.rs`, `.swift`, `.ts`, `.tsx` |
| `//` | `.jsonc` |
| `#` | `.ps1`, `.py`, `.sh`, `.toml`, `.yaml`, `.yml`, `Dockerfile`, `network-policy` |
| `<!-- … -->` | `.html`, `.md` |

## Reviewed exclusions

Each rule is a category with a justification. A rule **names the files it excludes, or states a structural property** that holds for anything it matches. A bare directory prefix does neither: it lends its justification to whatever is added to that directory next, which is the failure this audit exists to prevent. `npm run check:asf-headers -- --report` prints the resolved file list for every rule.

| Rule | Why the header does not belong |
| --- | --- |
| `asf-release-documents` | `LICENSE`, `NOTICE`, and `DISCLAIMER-WIP` are the license and notice themselves. |
| `third-party-license-texts` | Verbatim upstream license and notice texts. They must stay byte-identical to what upstream published, and the executor preparation scripts verify their digests. |
| `third-party-source` | Third-party work under its own license, including mixed-origin files Maka adapted from upstream. See below. |
| `generated-files` | Mechanically derived and byte-compared against a fresh generator run, so a hand-written header would be reverted by the next regeneration. The generators carry the header. |
| `verbatim-runtime-payloads` | Bundled skill payloads are embedded in the generated catalog verbatim, pinned by content digest, and delivered to the model as instructions. Each payload is listed by name. |
| `verbatim-github-templates` | GitHub copies the pull request template into every new pull request description. |
| `byte-significant-fixtures` | Recorded inputs and captured historical state, asserted on byte-for-byte or parsed by a strict reader. |
| `no-comment-syntax` | JSON and CSV have no comment syntax; a header could only be added by corrupting the file for its parser. |
| `binary-files` | Binary content cannot carry a text header. |
| `no-creative-content` | Version-control metadata and platform manifests whose content is a list of names or required platform keys. Apache RAT excludes the same kind of file by default. |

## Third-party and mixed-origin source

[ASF policy](https://www.apache.org/legal/src-headers.html#3party) treats the portion of a file that was not contributed by the copyright owner as third-party work. A file Maka adapted from an upstream project is therefore not Maka's to license wholly, and a mechanical sweep may not assert a whole-file ASF header over one. Whether a heavily modified file should instead carry a combined header is a PPMC decision, taken case by case.

Such files are excluded here and their attribution belongs to `LICENSE` and the `NOTICE` audit, not to this gate.

## Unreviewed provenance

This gate cannot determine provenance — that is a fact about people, not a property of a path — but it can refuse to let an unreviewed claim of it through. A covered file that carries an SPDX identifier, an explicit copyright line, or an adaptation notice fails the audit unless it appears in `reviewedProvenance` with the decision that nonetheless put an ASF header on it.

The markers are deliberately narrow, chosen by measuring them against the whole tree. Those three hit three files between them. `derived from` hits seventy, and an upstream project name such as `opencode` hits forty-five, because Maka supports it as a provider; a net that noisy gets answered with a list of paths added to quiet it, which is the outcome this rule exists to avoid.

This is a net, not a proof. It catches a file that states its origin. It cannot catch prose that merely alludes to one.

## The protocol compatibility epoch

`scripts/protocol-epoch-check.mjs` requires an epoch bump whenever a file under the Runtime Host protocol directory changes. That proxy is deliberately conservative — a needless bump costs a number, a missed one ships two incompatible protocols under one — but inserting a license header provably does not change the protocol, and bumping for it would tell every peer the wire is incompatible over a comment.

The guard therefore exempts a change that is exactly `applyHeader` applied to the previous content, using the same authority that writes the headers. A file that gained a header *and* a real edit fails that comparison and still requires an epoch.

## Changing the policy

Adding a file type means adding it to `coveredExtensions` or `coveredNames` and running `npm run write:asf-headers`.

Adding an exclusion means adding a rule with an `id` and a `justification` that a mentor can evaluate without reading the code around it. "The audit failed on it" is not a justification. If a file is source that Maka wrote, it gets the header.
