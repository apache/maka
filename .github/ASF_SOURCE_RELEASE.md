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

# Apache Maka source release runbook

This runbook prepares the official Apache Incubator source release. npm, Desktop, and other convenience artifacts use separate build, licensing, signing, and acceptance processes; they are not part of this source candidate or its release vote. Stable convenience artifacts, when provided, are built from the approved source release and tag.

The workflow implements release mechanics; it does not replace the human review of candidate provenance and release documents performed through the project's release vote.

## Candidate contract

- Archive: `apache-maka-<version>-incubating-src.tar.gz`
- Archive root: `apache-maka-<version>-incubating/`
- Checksum: `<archive>.sha512`
- Detached signature: `<archive>.asc`
- Staging directory: `<version>-incubating-rc<rc>/`
- Candidate tag: `v<version>-incubating-rc<rc>`

The RC number identifies a staging attempt and is not part of the archive name.
If any candidate byte changes, increment the RC number and restart the vote. Do
not replace files in a directory that has been presented for a vote.

The unsigned workflow handoff is identified by its exact source commit, not by
an RC number. Assign the RC identity only when creating the immutable candidate
tag and staging directory for the bytes selected by the Release Manager.

## Prerequisites

1. The intended version is committed to the root `package.json` on `main`.
2. Normal CI is green for the exact commit.
3. The PPMC and mentors have confirmed that provenance, `LICENSE`, `NOTICE`, and
   `DISCLAIMER-WIP` are ready for an Incubator release vote.
4. The Release Manager has a public ASF-associated RSA PGP key whose actual
   signing key or subkey is at least 2048 bits and whose full fingerprint can be
   reviewed independently. New keys should be 4096-bit RSA.
5. The podling `KEYS` file contains that public key and is published from the
   Apache distribution area, not only from GitHub.

## Build and test an unsigned candidate

Normal PR and main CI create and validate an unsigned archive of the checked-out commit on every run, including documentation and asset changes. This install-free check catches source inventory and dependency-boundary drift before a Release Manager dispatches the full candidate workflow. It does not sign, stage or publish an RC. The reviewed external website build dependency boundary is recorded in [`docs/code-origin-audit.md`](../docs/code-origin-audit.md#website-build-dependency-boundary).

Run **Prepare ASF source candidate** from `main`, supplying the exact version.
The workflow:

1. builds the archive from the dispatched Git commit rather than the working
   tree;
2. generates and validates SHA-512;
3. checks the archive identity and required legal documents;
4. extracts the exact archive into a clean directory;
5. installs, audits, builds, type-checks, runs release checks, and tests from
   that extracted directory; and
6. uploads an unsigned workflow artifact for Release Manager handoff.

An equivalent unsigned archive can be created locally:

```sh
npm run release:asf:source -- \
  --version <version> \
  --revision <full-commit-sha>

npm run release:asf:verify -- \
  --artifact release/asf/apache-maka-<version>-incubating-src.tar.gz
```

Creation refuses to overwrite existing output. Remove or move a private local
attempt before rebuilding; never overwrite a staged or voted candidate.
Different gzip implementations may encode the same source tar payload into
different compressed bytes, so use the workflow artifact as the candidate that
will be signed rather than substituting a locally compressed archive.

Before opening the vote, create the candidate tag at the exact archived commit
and publish it through the normal reviewed Git process:

```sh
git tag -s v<version>-incubating-rc<rc> <full-commit-sha>
git verify-tag v<version>-incubating-rc<rc>
git show --no-patch --format=fuller v<version>-incubating-rc<rc>^{commit}
```

Pushing the tag is a separate authenticated maintainer action. Confirm its
target and signature before publishing it; the automation does not push tags.

## Sign locally

Never place a Release Manager's private PGP key in GitHub Actions or the
repository. Download the unsigned workflow artifact and its SHA-512 file onto
the Release Manager's machine. In a clean, trusted checkout containing the
verified candidate tag, run:

```sh
npm run release:asf:sign -- \
  --artifact <candidate-dir>/apache-maka-<version>-incubating-src.tar.gz \
  --key <full-pgp-fingerprint> \
  --revision v<version>-incubating-rc<rc>
```

The signing command first validates the downloaded SHA-512 and archive. It then
rebuilds the canonical uncompressed Git archive from the specified revision on
the Release Manager's hardware, isolated from repository-local, user, and system
Git attributes, and requires that source payload to be byte-for-byte identical
to the downloaded candidate after decompression. The original downloaded
candidate is then signed with SHA-512 after resolving the selected secret key to
the exact full fingerprint. Comparing the canonical payload avoids treating a
platform's gzip encoding as source identity. A workflow-produced digest alone
is not an independent trust check and is insufficient for signing.

Start from a reviewed copy of the current podling `KEYS` file, then append the
matching public key when needed:

```sh
(gpg --list-sigs <full-pgp-fingerprint> && gpg --armor --export <full-pgp-fingerprint>) >> KEYS
gpg --show-keys --with-fingerprint KEYS
```

Review the combined file before publishing it. Retain every key that has been
used to sign an Apache Maka release.

Verify the complete signed candidate in a temporary keyring populated only
from the reviewed `KEYS` file:

```sh
npm run release:asf:verify -- \
  --artifact <candidate-dir>/apache-maka-<version>-incubating-src.tar.gz \
  --keys <path-to-reviewed-KEYS>
```

Supplying `--keys` requires a detached signature. Verification rejects signing
keys or subkeys that are not RSA with at least 2048 bits, expired or revoked
keys and signatures, SHA-1 or any digest outside the accepted set, and bad or
missing signatures. SHA-256, SHA-384, and SHA-512 signatures are accepted.

## Stage on Apache dist/dev

Release Managers need ASF commit access to the distribution repository. Check
out the podling development area, create a new immutable RC directory, and add
only the source archive, SHA-512 file, and detached signature:

```sh
svn checkout https://dist.apache.org/repos/dist/dev/incubator/maka maka-dist-dev
mkdir maka-dist-dev/<version>-incubating-rc<rc>
cp apache-maka-<version>-incubating-src.tar.gz{,.sha512,.asc} \
  maka-dist-dev/<version>-incubating-rc<rc>/
svn add maka-dist-dev/<version>-incubating-rc<rc>
svn commit maka-dist-dev -m "Stage Apache Maka <version> incubating RC<rc>"
```

Publish or update `KEYS` at the podling distribution root through the same
reviewed ASF distribution process. Confirm the staged HTTPS URLs before sending
the vote email.

## Independent verification

Inspect a fresh, unbuilt extraction before running installation or tests. Distinguish files shipped in the archive from files generated by those commands. An inventory entry establishes provenance; it does not automatically make a binary suitable for a source distribution. Store historical SQLite test fixtures as SQL and reconstruct them during tests, preserving the historical schema and rows rather than generating them through current application code. Do not exclude fixtures that the extracted source needs to run its tests.

Check each third-party entry against the archive's actual files. Dependency patches and copied or adapted source need attribution even when the upstream npm package is downloaded separately. Conversely, an installed dependency is not necessarily bundled source. Make the component-to-file mapping explicit in root `LICENSE`; long license texts may remain in package-local files referenced from it. Keep runtime bundle inventories separate and avoid duplicating license authorities.

Before using `DISCLAIMER-WIP`, verify each stated outstanding item against secretary acknowledgments or mentor-confirmed records. A stale incubation checklist or existing disclaimer is not proof that a software grant or ICLA remains outstanding. Describe the actual gap without claiming completion from an account roster alone.

Publish the signing public key at `https://dist.apache.org/repos/dist/release/incubator/maka/KEYS` and check that URL before the vote. Publishing KEYS does not publish or approve candidate artifacts. Download the staged files again and verify their signatures and identity against the signed tag; an uploaded workflow artifact or a locally verified copy alone does not establish what reviewers receive.

Before casting a binding `+1`, every voter must download all signed source
packages and the published `KEYS` over HTTPS onto their own hardware, validate
ASF release-policy compliance and all cryptographic signatures, inspect the
archive, and compile/test the extracted source. Non-binding voters are strongly
encouraged to perform the same checks. Voters should record the commit, SHA-512,
signing-key fingerprint, platform, and commands used.

## Vote requirements

Both the podling and Incubator PMC review periods should normally remain open
for at least 72 hours. A shortened vote is only for exceptional expedited
releases; the vote email must explain why it is expedited, and the deviation
must be reported through the ASF process.

The podling vote passes only with at least three PPMC `+1` votes and more `+1`
than `-1` votes. After that result is summarized to the Incubator general list,
the release requires at least three Incubator PMC `+1` votes and more binding
`+1` than binding `-1` votes.

## Podling vote template

Send to `dev@maka.apache.org` and allow at least 72 hours.

```text
Subject: [VOTE] Release Apache Maka <version> (incubating) RC<rc>

Hello Apache Maka community,

This is a vote to release Apache Maka <version> (incubating), release candidate <rc>.

The source candidate:
<dist-dev-candidate-url>

The source commit:
<commit-url-and-full-sha>

The KEYS file:
<published-keys-url>

Please review and vote:
[ ] +1 Release this package
[ ]  0 No opinion
[ ] -1 Do not release this package (please provide the reason)

The vote will remain open for at least 72 hours.
```

After the podling vote passes, send a vote to
`general@incubator.apache.org`, linking the podling result and presenting the
same immutable candidate bytes. Apply the requirements above independently to
this Incubator PMC vote.

## Follow review feedback and replace a candidate

Use the public vote archive as the record of replies and vote timestamps. Subscribing to the mailing list delivers future traffic; it does not backfill the existing thread into an inbox. The archive's reply action can respond to a specific review message using an authenticated ASF identity. Keep replies in that thread and check the sending identity and recipient list. Cite the checks actually performed, including failed or incomplete platform tests; do not turn a green workflow into a claim of independent local verification.

Acknowledge feedback, then compare each report with the exact signed archive. Separate confirmed defects, clarification requests, and policy interpretations. Link evidence for existing license pointers or KEYS rather than making duplicate changes. A `0` vote is not a veto, but review concerns still need a response.

If a repair changes the archive, send a cancellation for the current vote, preserve the old RC directory and tag, merge the focused repair, and create the next RC from an explicitly selected commit. Re-run candidate qualification, signing, public-download verification and the applicable votes for the new bytes. Previous approvals are evidence about the previous candidate, not approval of the replacement. Before moving from a project vote to an IPMC vote, send the project result with named voters and archive links; distinguish PPMC votes from IPMC binding votes and never count the same person twice.

## Publish after approval

Only after both required votes pass, copy the exact approved files from the
development distribution area to the appropriate Apache release distribution
area, update the download page, and announce the release. Do not rebuild or
rename the approved archive during promotion.

Current policy references:

- https://incubator.apache.org/guides/releasemanagement.html
- https://incubator.apache.org/guides/distribution.html
- https://www.apache.org/legal/release-policy.html
- https://infra.apache.org/release-distribution.html
