# Apache Maka npm convenience candidate runbook

This runbook prepares the `maka-agent` npm convenience artifact for the first
Apache Maka (Incubating) release. The official ASF release is the source
release. The npm package is an additional distribution form and must be built
from the exact source release commit, reviewed independently, and published
only after the source release is approved.

## Candidate contract

For version `<version>` and source release candidate `<rc>`, the workflow
produces one unsigned handoff artifact containing:

- `maka-agent-<version>.tgz`;
- the existing SHA-256 sidecar used by the npm publication verifier;
- `maka-agent-<version>.tgz.sha512` for ASF release review;
- the npm pack file inventory; and
- `maka-agent-<version>.tgz.asf-candidate.json`, which binds those exact bytes
  to the source reference `v<version>-incubating-rc<rc>`, its full commit, and
  the producing workflow run attempt.

The workflow builds the tarball once and passes the same bytes through the
Linux, macOS, Windows, and Eval validation matrix. It does not call npm
staging, publish a package, modify a dist-tag, sign the tarball, or establish
that the source candidate has passed either required vote.

## Prerequisites

1. The intended source candidate tag
   `v<version>-incubating-rc<rc>` exists as a signed annotated tag at a commit
   on `main`. The Release Manager has independently verified the tag signature
   with the trusted ASF `KEYS` material as required by the source-release
   runbook.
2. The root product version and `packages/cli/package.json` version both equal
   `<version>` at that commit.
3. The source candidate was prepared and reviewed under
   [ASF_SOURCE_RELEASE.md](./ASF_SOURCE_RELEASE.md).
4. The reusable CLI package validation workflow is green for the exact commit.

## Prepare the unsigned candidate

Dispatch **Prepare ASF npm candidate** from the exact source candidate tag:

```sh
version=0.1.11
rc=1
source_reference_tag="v${version}-incubating-rc${rc}"
gh workflow run asf-npm-candidate.yml \
  --ref "$source_reference_tag" \
  -f source_reference_tag="$source_reference_tag"
```

The workflow rejects a fork repository, a lightweight tag, a tag/version/RC
mismatch, a tag that does not resolve to the dispatched commit, and a commit
outside current `main`. These checks pin a source reference; they do not
authenticate its signature or establish source-release approval. Its reusable
validation job builds one clean-source npm tarball and tests that exact artifact
across the supported platform matrix. The final job adds only the source
reference/run record and uploads a new handoff artifact; it never rebuilds the
tarball. The handoff requires validation from the current workflow attempt. If
validation or handoff must be retried, re-run the validation job and its
dependent jobs; the handoff independently revalidates the live source tag, so
the successful resolve job does not need to be repeated.

## Verify the handoff

After downloading and extracting the workflow artifact, verify the record and
both checksum sidecars from a trusted checkout of the same source commit:

```sh
npm run release:asf:npm:verify -- \
  <candidate-dir>/maka-agent-<version>.tgz.asf-candidate.json
```

Review the JSON record directly and confirm the full source commit, source
reference tag, workflow run ID, and run attempt against GitHub. Treat the
tarball as immutable after it enters release review. Any byte change requires a
new npm package version and, when the source commit changes, a new source RC.

## Publication boundary

This preparation workflow is deliberately credential-free. Before any npm
approval or public publication, G8 still requires:

- artifact-specific legal and dependency review;
- the reviewed detached-signature path and independent signature verification;
- the mentor/IPMC decision on the npm package name;
- a recorded successful source-release vote result;
- PPMC-controlled npm ownership, OIDC, 2FA recovery, and approval; and
- verification that npm staging and the public registry preserve these exact
  candidate bytes and their provenance.

Do not infer source-release approval from a successful candidate workflow or
from the existence of an RC tag.

## References

- https://incubator.apache.org/guides/distribution.html#npm
- https://incubator.apache.org/guides/releasemanagement.html
- https://www.apache.org/legal/release-policy.html
- https://www.apache.org/legal/resolved.html
