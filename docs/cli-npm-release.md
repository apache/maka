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

# Maka CLI npm release operations

[简体中文](./cli-npm-release.zh-CN.md)

This runbook is the operational authority for publishing the `maka-agent` npm installation channel. The root `package.json` remains the sole Maka product-version authority, and `packages/cli/package.json` must match it. Every public npm version must come from the exact tarball validated by the Stage workflow.

The IPMC-approved source archive on ASF distribution infrastructure is the Apache release. npm,
Desktop installers, and GitHub Release assets are convenience packages built from that approved
source identity; they are not additional ASF release artifacts.

The source-RC [npm preflight](../.github/ASF_NPM_RELEASE.md) is an earlier, credential-free
compatibility check. Its tarball is not carried into publication. After source approval, Stage
rebuilds from the final product tag at the same approved commit and becomes the byte authority for
npm staging and registry verification. This matches Apache OpenDAL's incubating practice while
retaining Maka's stronger protected-Environment, staged-publishing, 2FA, and Finalize controls.

## Release invariants

- Dispatch the product Release workflow only from the exact approved ASF source candidate tag.
  Dispatch npm Stage from the resulting product `v<version>` tag and product Finalize from `main`.
- Publish prereleases under `next` and stable versions under `latest`. `next` must never resolve to
  a version older than `latest`; when no newer prerelease exists, both tags point to the stable
  version.
- Do not create an npm-specific Git tag or GitHub Release. The `Release` workflow creates the
  product `v<version>` tag and Draft before npm staging; Finalize is the sole publisher of that Draft.
- Keep that GitHub Release in Draft until npm Finalize and Desktop remote Runtime Host acceptance
  succeed. The Draft supplies npm's product identity; its publication is the final product action.
- Do not run `npm publish`. GitHub Actions may only run `npm stage publish`; a human package
  maintainer approves the staged package with npm 2FA.
- Do not rebuild between validation, staging, approval, and finalization.
- Never reuse a public version. Fixes require a new prerelease, patch, minor, or major version.

The two workflow boundaries are:

1. [Stage CLI npm release](../.github/workflows/release-cli-stage.yml) resolves the existing product
   tag and GitHub Release, checks out that exact product commit, builds and validates one immutable
   tarball, records that single tag commit and workflow run, enters the protected `npm-release`
   Environment, and submits it to npm staging through OIDC.
2. [Finalize product release](../.github/workflows/release-cli-finalize.yml) accepts only the exact
   successful Stage run, Release build run, and self-contained publication record. The current
   reviewed verifier on `main` checks the public registry bytes, signature, provenance, dist-tag,
   immutable build artifacts, and live Draft digests, then waits at the protected `product-release`
  Environment. After independent Desktop acceptance, approval attests the exact convenience
  artifacts with the protected workflow identity, publishes the GitHub Release, and applies its
  Stable/Latest classification in one operation.

## One-time control-plane configuration

### GitHub Environment

The checked-in `.asf.yaml` is the authority for the `npm-release` and `product-release`
Environments. After it reaches
`main`, confirm ASF reconciliation produced:

- a selected `v*` tag rule for `npm-release` and a selected `main` branch rule for
  `product-release`;
- `M4n5ter` as the required reviewer;
- self-review disabled;
- administrator bypass disabled where repository policy permits it.

Repository administration permission is required to inspect or repair reconciliation. Do not maintain
a second manual Environment policy in GitHub. Finalize uses GitHub Actions OIDC to create Sigstore
provenance for the exact convenience artifacts and stores the offline verification bundle beside
them. It requires no repository-administration credential, signing key, or npm token.

### npm Trusted Publisher

In the `maka-agent` package settings, configure one GitHub Actions trusted publisher:

| Field | Value |
| --- | --- |
| Organization or user | `apache` |
| Repository | `maka` |
| Workflow filename | `release-cli-stage.yml` |
| Environment name | `npm-release` |
| Allowed actions | `npm stage publish` only |

The workflow filename is case-sensitive and contains no `.github/workflows/` prefix. Keep
`npm publish` disabled for this trust relationship.

After the first OIDC Stage succeeds, set package publishing access to **Require two-factor
authentication and disallow tokens**, then revoke obsolete publish tokens. Do not remove the human
package owner or recovery access as part of that change.

## Prepare a release

1. Merge all intended package, documentation, and release changes to `main`, prepare the ASF source
   candidate, and complete both the podling and Incubator PMC votes.
2. Confirm the root product version, `apps/desktop/package.json`, and
   `packages/cli/package.json` have the same unused target version at the approved source commit.
   The npm channel maps prerelease versions to `next` and stable versions to `latest`.
3. Dispatch the product `Release` workflow from the exact approved
   `v<version>-incubating-rc<rc>` tag, supplying that same tag as `source_reference_tag`. Confirm its
   Draft `v<version>` Release points to the approved commit. npm staging consumes this identity and
   cannot precede it.
4. Confirm the target version is absent from both public and staged package state:

   ```sh
   version=0.1.0-beta.1
   npm view "maka-agent@$version" version --registry https://registry.npmjs.org/
   npm stage list maka-agent --registry https://registry.npmjs.org/
   ```

   The first command should report that the target version is not present. Resolve any existing
   stage instead of submitting the same version again.
5. Confirm the `npm-release` Environment and Trusted Publisher still match the values above and the
   approving npm account has 2FA enabled.

## Stage the candidate

1. Dispatch the workflow with the exact product tag as its GitHub ref:

   ```sh
   version=0.1.0-beta.1
   gh workflow run release-cli-stage.yml --ref "v$version" -f version="$version"
   ```

2. Confirm the created run uses `v<version>`. The workflow requires its GitHub ref, checkout, product tag, Release, source commit, and npm provenance to identify that one tag commit, and requires the commit to remain an ancestor of `main`.
3. Wait for the reusable package validation jobs to pass. They build one tarball and validate the
   installed CLI on Linux x64/arm64, macOS arm64, and Windows x64, plus real Harbor and Pier
   Docker cells on Linux x64.
4. Review and approve the `npm-release` Environment deployment.
5. Record the successful Stage workflow run ID, run attempt, source commit, version, and staged
   artifact checksum from the run summary and `cli-staged-release-<attempt>` artifact.

Do not approve anything on npm if the Stage workflow did not finish successfully.

## Inspect and approve on npm

Use Node.js 22.14.0 or newer and npm 11.15.0 or newer for the inspection and approval commands below. The Stage workflow uses its own reviewed toolchain: the Node.js version pinned in the workflow and the exact npm version pinned in the repository's `packageManager`.

```sh
npm stage list maka-agent --registry https://registry.npmjs.org/
stage_id=replace-with-reviewed-stage-id
npm stage view "$stage_id" --registry https://registry.npmjs.org/
npm stage download "$stage_id" --registry https://registry.npmjs.org/
```

Before approval:

- require the package name, version, dist-tag, provenance, and source repository to match the Stage
  run;
- compare the downloaded staged tarball's SHA-256 with the workflow artifact's `.tgz.sha256`;
- inspect the file inventory and the packaged `README.md`;
- confirm the tarball belongs to the recorded Stage run and source commit.

Immediately before approval, recheck the live product authority recorded by the Stage run:

```sh
set -eu
source_commit=replace-with-stage-recorded-commit
node scripts/product-release-authority.mjs verify-draft \
  "v$version" "$source_commit" apache/maka
```

The verifier must succeed. Stop if the tag is absent, moved, no longer on `main`, the matching
GitHub Release is no longer a Draft, or its prerelease classification does not match the version.

Approve only that stage ID. npm requires 2FA and makes the package public as part of approval:

```sh
npm stage approve "$stage_id" --registry https://registry.npmjs.org/
```

The same review and approval can be performed from the package's **Staged Packages** page on
npmjs.com.

For a stable release, inspect the public tags after approval:

```sh
version=0.1.0
npm view maka-agent dist-tags --json --registry https://registry.npmjs.org/
```

If `next` is absent or older than `latest`, authenticate interactively as an npm package owner and
advance it to the new stable version before running Finalize:

```sh
npm dist-tag add "maka-agent@$version" next --registry https://registry.npmjs.org/
```

Do not change `next` when it already points to a newer version such as `0.2.0-beta.1`. This step is
intentionally manual: npm Trusted Publishing authenticates `npm publish` and `npm stage publish`,
not dist-tag mutations, and the release workflows must not gain a long-lived npm token.

## Finalize the product release

After npm reports the version as public:

1. Open **Actions → Finalize product release → Run workflow** on `main`.
2. Enter the successful Stage run ID and attempt, the successful Release build run ID and attempt,
   and the version.
3. Let the inspection job verify the public tarball bytes, checksum, inventory, npm signature,
   Trusted Publishing provenance, the release dist-tag, and that `next` is not older than `latest`.
4. While the publication job waits for `product-release` approval, complete the product checklist's
   cross-machine acceptance against the Draft.
5. Approve the Environment. Confirm the workflow matches every live Draft digest to the exact
   Release attempt's publication record, creates and uploads
   `Maka-<version>-attestation.sigstore.json`, publishes the convenience Release, and makes a stable
   release Latest without a separate manual action.

Check the resulting registry state:

```sh
version=0.1.0-beta.1
npm view "maka-agent@$version" version dist.tarball dist.integrity --json
npm view maka-agent dist-tags --json
```

Finally, install the exact public version on each release platform and complete one real TUI/model
turn. On the supported Eval host, complete at least one real experiment cell and inspect score,
usage, cost, and artifacts.

The [product release checklist](../.github/RELEASE_CHECKLIST.md) remains the authority for the
acceptance evidence required before approving publication.

## Failure recovery

### Before npm staging

If a transient failure occurs before `npm stage publish`, rerun Stage from the same product tag. If code or workflow changes are required, fix them on `main`, increment the product version, create a new product tag and Draft, and Stage that new version. No npm version has been consumed.

### Stage workflow failed but npm contains a stage

The submission is the Stage workflow's final business step, so a lost response can leave npm with a
stage even when the workflow is not successful. Do not approve that orphan: Finalize accepts only a
successful Stage run attempt.

Inspect it, then reject the exact stage ID with 2FA before starting a new Stage run:

```sh
stage_id=replace-with-reviewed-stage-id
npm stage view "$stage_id" --registry https://registry.npmjs.org/
npm stage reject "$stage_id" --registry https://registry.npmjs.org/
```

Never reject a stage based only on version text; bind the action to the inspected stage ID.

### Stage succeeded but review found a problem

Reject the stage, fix the problem on `main`, increment the product version, create a new product tag and Draft, and Stage that new version. Do not approve a candidate merely to clear the staging area.

### npm approval succeeded but Finalize failed

The npm version is already immutable. Do not publish or approve it again. Preserve the Stage run ID,
attempt, version, and the Release run ID, attempt, publication record, and artifacts. If those bytes
and provenance are valid, fix the Finalize verifier on `main` and rerun it against the same immutable
Stage and Release evidence.

The inspection job is read-only. Only the protected publication job may perform the single
Draft-to-published transition and attest its bytes. If npm identity, build evidence, or the Draft differs, stop and
investigate; do not modify the product tag or GitHub Release to make verification pass. If failure is
reported after the publication request, inspect the exact Release first: a successful publication
must not be repeated.

### The public version is defective

First move the affected dist-tag back to a previously verified version:

```sh
known_good=0.1.0-beta.1
npm dist-tag add "maka-agent@$known_good" next
# For a stable release incident, use latest instead of next.
```

Then deprecate only the defective version and direct users to the recovered dist-tag, which already
points to the verified version:

```sh
bad_version=0.1.0-beta.2
recovery_tag=next
# For a stable release incident, use latest instead of next.
npm deprecate "maka-agent@$bad_version" "Known issue; install maka-agent@$recovery_tag."
```

Verify the tags, fix the defect, and release a new version through the complete Stage and Finalize
flow. Do not use `npm unpublish` as routine rollback: removing immutable dependency bytes can break
existing installations and does not restore the reviewed release chain.

## Ownership and emergency recovery

- GitHub repository admins own the `npm-release` Environment configuration. The release maintainer
  owns dispatch, Environment review, staged-package inspection, npm 2FA approval, and final
  acceptance.
- npm package owners own Trusted Publisher, publishing-access, maintainer, and dist-tag recovery.
- Keep at least one 2FA-protected human owner while trusted publishing is active. Before removing the
  current direct owner, add the intended npm organization publishing team and another direct human
  recovery maintainer, then verify both paths.
- The workflows must not gain a long-lived npm token. If OIDC, the Environment, or the trust
  relationship is broken, pause releases and repair that control plane instead of bypassing staging
  with `npm publish`.
- If an npm account is lost, use its account recovery methods or another verified package owner.
  Until a second owner is established, recovery depends on the current owner's npm recovery
  credentials; treat completing that ownership follow-up as operational debt.
- If repository or npm publisher settings change unexpectedly, remove or disable the trust
  relationship, preserve workflow and npm audit evidence, restore the reviewed configuration, and
  use a new version for any candidate whose integrity is uncertain.

## References

- [ASF Incubator distribution guide: npm](https://incubator.apache.org/guides/distribution.html#npm)
- [Apache OpenDAL incubating Node.js release workflow](https://github.com/apache/opendal/blob/v0.44.0/.github/workflows/bindings_nodejs.yml)
- [Apache OpenDAL incubating release guide](https://github.com/apache/opendal/blob/v0.44.0/website/community/committers/release.md)
- [npm staged publishing](https://docs.npmjs.com/staged-publishing/)
- [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/)
- [npm dist-tags](https://docs.npmjs.com/cli/dist-tag/)
- [npm deprecation](https://docs.npmjs.com/cli/v11/commands/npm-deprecate/)
- [GitHub deployment environments](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments)
