# Maka CLI npm release operations

[简体中文](./cli-npm-release.zh-CN.md)

This runbook is the operational authority for publishing `maka-agent`. The package version is
independent of the Desktop release line. Every public version must come from the exact tarball
validated by the Stage workflow.

## Release invariants

- Dispatch release workflows only from `main`.
- Publish prereleases under `next` and stable versions under `latest`. `next` must never resolve to
  a version older than `latest`; when no newer prerelease exists, both tags point to the stable
  version.
- Use the Git tag `cli-v<version>`; CLI releases never replace the Desktop GitHub Latest release.
- Do not run `npm publish`. GitHub Actions may only run `npm stage publish`; a human package
  maintainer approves the staged package with npm 2FA.
- Do not rebuild between validation, staging, approval, and finalization.
- Never reuse a public version. Fixes require a new prerelease, patch, minor, or major version.

The two workflow boundaries are:

1. [Stage CLI npm release](../.github/workflows/release-cli-stage.yml) builds and validates one
   immutable tarball, records its source identity, enters the protected `npm-release` Environment,
   and submits it to npm staging through OIDC.
2. [Finalize CLI npm release](../.github/workflows/release-cli-finalize.yml) accepts only the exact
   successful Stage run and attempt, verifies the public registry bytes, signature, provenance, and
   dist-tag, then creates the exact Git tag and a non-Latest GitHub Release.

## One-time control-plane configuration

### GitHub Environment

Create an Environment named `npm-release` with:

- `main` as the only allowed deployment branch;
- the active CLI release maintainer as a required reviewer;
- self-review allowed while one person is the sole release maintainer;
- administrator bypass disabled where repository policy permits it;
- no environment secrets or variables.

Repository administration permission is required to configure the Environment. The workflow itself
uses GitHub OIDC and does not read an npm token.

### npm Trusted Publisher

In the `maka-agent` package settings, configure one GitHub Actions trusted publisher:

| Field | Value |
| --- | --- |
| Organization or user | `maka-agent` |
| Repository | `maka-agent` |
| Workflow filename | `release-cli-stage.yml` |
| Environment name | `npm-release` |
| Allowed actions | `npm stage publish` only |

The workflow filename is case-sensitive and contains no `.github/workflows/` prefix. Keep
`npm publish` disabled for this trust relationship.

After the first OIDC Stage succeeds, set package publishing access to **Require two-factor
authentication and disallow tokens**, then revoke obsolete publish tokens. Do not remove the human
package owner or recovery access as part of that change.

## Prepare a release

1. Merge all intended package, documentation, and release changes to `main`.
2. Set `packages/cli/package.json` to the unused target version and merge that change. The release
   tool maps prerelease versions to `next` and stable versions to `latest`.
3. Confirm the target version is absent from both public and staged package state:

   ```sh
   version=0.1.0-beta.1
   npm view "maka-agent@$version" version --registry https://registry.npmjs.org/
   npm stage list maka-agent --registry https://registry.npmjs.org/
   ```

   The first command should report that the target version is not present. Resolve any existing
   stage instead of submitting the same version again.
4. Confirm the `npm-release` Environment and Trusted Publisher still match the values above and the
   approving npm account has 2FA enabled.

## Stage the candidate

1. Open **Actions → Stage CLI npm release → Run workflow**.
2. Select `main` and enter the exact version from `packages/cli/package.json`.
3. Wait for the reusable package validation jobs to pass. They build one tarball and validate the
   installed CLI on Linux x64, macOS arm64, and Windows x64, plus real Harbor and Pier Docker cells
   on Linux x64.
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

## Finalize the public release

After npm reports the version as public:

1. Open **Actions → Finalize CLI npm release → Run workflow** on `main`.
2. Enter the successful Stage run ID, its exact run attempt, and the version.
3. Let the inspection job verify the public tarball bytes, checksum, inventory, npm signature,
   Trusted Publishing provenance, the release dist-tag, and that `next` is not older than `latest`.
4. Review and approve the `npm-release` Environment deployment for the Git tag and GitHub Release.
5. Confirm the workflow created `cli-v<version>` at the Stage source commit. A prerelease must be
   marked prerelease; no CLI release may become the repository's GitHub Latest release.

Check the resulting registry state:

```sh
version=0.1.0-beta.1
npm view "maka-agent@$version" version dist.tarball dist.integrity --json
npm view maka-agent dist-tags --json
```

Finally, install the exact public version on each release platform and complete one real TUI/model
turn. On the supported Eval host, complete at least one real experiment cell and inspect score,
usage, cost, and artifacts.

## Failure recovery

### Before npm staging

If validation or Environment approval fails before `npm stage publish`, fix the problem on `main`
and start a new Stage run. No npm version has been consumed.

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

Reject the stage, fix the problem on `main`, and stage again. Do not approve a candidate merely to
clear the staging area.

### npm approval succeeded but Finalize failed

The npm version is already immutable. Do not publish or approve it again. Preserve the Stage run ID,
attempt, version, and artifacts. If the package bytes and provenance are valid, fix the current
Finalize verifier on `main` and rerun Finalize against that same successful Stage identity.

Finalize is idempotent across partial GitHub Release creation: it resumes an exact draft and accepts
an already-published release only after verifying its metadata and asset digests. If an existing
`cli-v<version>` tag points anywhere other than the recorded Stage source commit, or an existing
published release differs from the verified candidate, stop and investigate. Do not move or delete
it to make the workflow pass.

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

- [npm staged publishing](https://docs.npmjs.com/staged-publishing/)
- [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/)
- [npm dist-tags](https://docs.npmjs.com/cli/dist-tag/)
- [npm deprecation](https://docs.npmjs.com/cli/v11/commands/npm-deprecate/)
- [GitHub deployment environments](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments)
