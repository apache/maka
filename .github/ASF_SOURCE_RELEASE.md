# Apache Maka source release runbook

This runbook prepares the official Apache Incubator source-release component.
The first Maka release also requires npm and Desktop convenience artifacts, but
those artifacts have separate build, licensing, signing, and acceptance gates.
They must be built from the exact IPMC-approved source release produced here.

The workflow implements release mechanics; it does not establish that a commit
is legally ready to release. Before starting a vote, the PPMC and mentors must
confirm the candidate's provenance and release documents.

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

## Prerequisites

1. The intended version is committed to the root `package.json` on `main`.
2. Normal CI is green for the exact commit.
3. The PPMC and mentors have confirmed that provenance, `LICENSE`, `NOTICE`, and
   `DISCLAIMER-WIP` are ready for an Incubator release vote.
4. The Release Manager has a public ASF-associated PGP key whose full
   fingerprint can be reviewed independently.
5. The podling `KEYS` file contains that public key and is published from the
   Apache distribution area, not only from GitHub.

## Build and test an unsigned candidate

Run **Prepare ASF source candidate** from `main`, supplying the exact version
and a positive RC number. The workflow:

1. builds the archive from the dispatched Git commit rather than the working
   tree;
2. generates and validates SHA-512;
3. checks the archive identity and required legal documents;
4. extracts the exact archive into a clean directory;
5. installs, audits, builds, type-checks, runs release checks, and tests from
   that extracted directory; and
6. uploads an unsigned workflow artifact for Release Manager handoff.

The same unsigned archive can be created locally:

```sh
npm run release:asf:source -- \
  --version <version> \
  --revision <full-commit-sha>

npm run release:asf:verify -- \
  --artifact release/asf/apache-maka-<version>-incubating-src.tar.gz
```

Creation refuses to overwrite existing output. Remove or move a private local
attempt before rebuilding; never overwrite a staged or voted candidate.

Before opening the vote, create the candidate tag at the exact archived commit
and publish it through the normal reviewed Git process:

```sh
git tag -s v<version>-incubating-rc<rc> <full-commit-sha>
git show v<version>-incubating-rc<rc>
```

Pushing the tag is a separate authenticated maintainer action. Confirm its
target and signature before publishing it; the automation does not push tags.

## Sign locally

Never place a Release Manager's private PGP key in GitHub Actions or the
repository. Download the unsigned workflow artifact, compare its SHA-512 with
the workflow output, and sign it on the Release Manager's machine:

```sh
npm run release:asf:sign -- \
  --artifact <candidate-dir>/apache-maka-<version>-incubating-src.tar.gz \
  --key <full-pgp-fingerprint>
```

Export the matching public key for the podling `KEYS` file when needed:

```sh
gpg --armor --export <full-pgp-fingerprint> > KEYS
gpg --show-keys --with-fingerprint KEYS
```

When preserving existing project keys, merge reviewed public-key blocks rather
than replacing the published `KEYS` file.

Verify the complete signed candidate in a temporary keyring populated only
from the reviewed `KEYS` file:

```sh
npm run release:asf:verify -- \
  --artifact <candidate-dir>/apache-maka-<version>-incubating-src.tar.gz \
  --require-signature \
  --keys <path-to-reviewed-KEYS>
```

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

At least one voter other than the Release Manager should download all candidate
files and the published `KEYS` over HTTPS, run the repository verifier, inspect
the archive, and build/test from the extracted source. Voters should record the
commit, SHA-512, signing-key fingerprint, platform, and commands used.

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
same immutable candidate bytes. Follow current Incubator voting requirements;
the release needs at least three binding IPMC `+1` votes and more binding `+1`
than binding `-1` votes.

## Publish after approval

Only after both required votes pass, copy the exact approved files from the
development distribution area to the appropriate Apache release distribution
area, update the download page, and announce the release. Do not rebuild or
rename the approved archive during promotion.

Current policy references:

- https://incubator.apache.org/guides/releasemanagement.html
- https://incubator.apache.org/guides/distribution.html
- https://www.apache.org/legal/release-policy.html
