/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

const workflows = resolve(import.meta.dirname, '../.github/workflows');

test('validation consumers download the artifact produced by the build job', () => {
  const workflow = readWorkflow('cli-package-validation.yml');
  assert.match(
    workflow,
    /workflow_call:[\s\S]*?\n\s+outputs:\n\s+release_candidate_artifact_id:[\s\S]*?value: \$\{\{ jobs\.build\.outputs\.release_candidate_artifact_id \}\}/u,
  );
  assert.match(
    workflow,
    /release_candidate_artifact_id: \$\{\{ steps\.release-candidate\.outputs\.artifact-id \}\}/u,
  );
  const downloads = workflowSteps(workflow).filter((step) =>
    step.includes('name: Download the release candidate'),
  );
  assert.ok(downloads.length > 0);
  for (const step of downloads) {
    assert.match(
      step,
      /artifact-ids: \$\{\{ needs\.build\.outputs\.release_candidate_artifact_id \}\}/u,
    );
  }
});

test('CLI validation qualifies exact published State Roots without weakening artifact identity', () => {
  const workflow = readWorkflow('cli-package-validation.yml');
  // The predecessor is resolved on the only job that reads it, rather than on
  // `build`, where a registry blip forfeited the most expensive job in the
  // workflow and everything downstream of it. The exported names are the
  // contract callers hold; the job behind them is not, because a reusable
  // workflow publishes its outputs only once every job has finished.
  assert.match(
    workflow,
    /release_predecessor_version:[\s\S]*?value: \$\{\{ jobs\.state-root-qualification\.outputs\.release_predecessor_version \}\}/u,
  );
  assert.match(
    workflow,
    /release_predecessor_integrity:[\s\S]*?jobs\.state-root-qualification\.outputs\.release_predecessor_integrity/u,
  );
  assert.match(
    workflow,
    /id: predecessor\n\s+run: node scripts\/release-cli-publication\.mjs resolve-nightly-predecessor "\$GITHUB_OUTPUT"/u,
  );
  assert.match(workflow, /state-root-qualification:\n[\s\S]*?needs: build\n/u);
  assert.doesNotMatch(workflow, /needs\.build\.outputs\.release_predecessor/u);

  // Both frozen transitions keep their exact digests and the epoch relation
  // each one exists to prove. They are positional arguments now, so anchor on
  // the digest immediately preceding the relation rather than on a YAML key.
  assert.match(workflow, /^\s+[a-f0-9]{64} different$/mu);
  assert.match(workflow, /^\s+[a-f0-9]{64} same$/mu);
  assert.match(
    workflow,
    /"\$PREDECESSOR_TARBALL_URL" '' "\$PREDECESSOR_INTEGRITY" \\\n\s+candidate/u,
  );

  // The env those two names come from. Without this the third transition would
  // still be spelled correctly while pointing at nothing, which is how the
  // `tarball_url` binding lost its only assertion when the predecessor moved
  // off its own job. `release_predecessor_tarball_url` is also a declared
  // `workflow_call` output, so callers hold it too.
  assert.match(
    workflow,
    /release_predecessor_tarball_url:[\s\S]*?value: \$\{\{ jobs\.state-root-qualification\.outputs\.release_predecessor_tarball_url \}\}/u,
  );
  for (const name of ['tarball_url', 'integrity']) {
    assert.match(
      workflow,
      new RegExp(
        `PREDECESSOR_${name.toUpperCase()}: \\$\\{\\{ steps\\.predecessor\\.outputs\\.${name} \\}\\}`,
        'u',
      ),
      name,
    );
  }

  const steps = workflowSteps(workflow);
  const sandbox = namedStep(steps, 'Require the account-isolation sandbox');
  assert.match(sandbox, /apt-get install --yes bubblewrap/u);
  const qualify = namedStep(steps, 'Qualify the released State Root transitions');
  assert.match(qualify, /release:cli:qualify-state-root/u);
  assert.match(qualify, /MAKA_QUALIFICATION_BWRAP_USE_SUDO:\s*'1'/u);
  assert.match(qualify, /--source-sha256/u);
  assert.match(qualify, /--target-sha256/u);
  assert.match(qualify, /--expect-epoch-relation/u);
  // `| tee` would otherwise report the exit code of tee, not the qualifier.
  assert.match(qualify, /set -euo pipefail/u);
  assert.match(qualify, /npm run --silent/u);
  assert.match(qualify, /--max-filesize 67108864/u);
  assert.match(qualify, /source_integrity/u);
  assert.match(qualify, /createHash\('sha512'\)/u);
  assert.match(qualify, /source_sha256="\$\(sha256sum/u);
  // The candidate is the only transition a pull request can influence, and the
  // three share one `set -e`, so it runs before either frozen tarball is
  // fetched. Read as positions in the script rather than restated, so a
  // reordering fails here instead of silently moving it back behind a `curl`.
  const script = [
    'current-nightly-predecessor-to-candidate',
    'cross-epoch-74-to-76',
    'same-epoch-76',
  ].map((slug) => qualify.indexOf(`qualify ${slug}`));
  assert.ok(
    script.every((index) => index >= 0),
    'a declared State Root transition is no longer invoked',
  );
  assert.deepEqual(
    [...script].sort((left, right) => left - right),
    script,
  );

  const preserve = namedStep(steps, 'Preserve the qualification reports');
  // `error` on a green run, where an empty directory means a broken path, and
  // `warn` on a red one: paired with `if: always()`, a plain `error` turned a
  // `curl` that failed before any `tee` into a second red on an already-red
  // job.
  assert.match(
    preserve,
    /if-no-files-found: \$\{\{ job\.status == 'success' && 'error' \|\| 'warn' \}\}/u,
  );
  const freshness = namedStep(steps, 'Require the qualified Nightly predecessor to remain current');
  assert.match(freshness, /assert-nightly-predecessor/u);
  assert.match(freshness, /steps\.predecessor\.outputs\.version/u);
  assert.ok(steps.indexOf(freshness) > steps.indexOf(preserve));
});

test('both supported Node versions validate the tarball even when the first fails', () => {
  // One runner and one tarball, so the two Node versions are two steps rather
  // than two jobs. Without this the first failing would end the job and the
  // second would never run at all — the matrix these replaced set
  // `fail-fast: false` for exactly that.
  const steps = workflowSteps(readWorkflow('cli-package-validation.yml'));
  const first = namedStep(steps, 'Validate the installed tarball');
  assert.match(first, /id: first-node-smoke/u);
  assert.match(first, /continue-on-error: true/u);

  const second = namedStep(steps, 'Validate the installed tarball on the second Node');
  assert.match(second, /if: matrix\.second_node != ''/u);
  assert.ok(steps.indexOf(second) > steps.indexOf(first));

  // `continue-on-error` alone would report a failing first Node as green, and
  // without `always()` a failing second Node would swallow it instead.
  const report = namedStep(steps, 'Report the first Node result');
  assert.match(report, /if: always\(\) && steps\.first-node-smoke\.outcome != 'success'/u);
  assert.match(report, /exit 1/u);
  assert.ok(steps.indexOf(report) > steps.indexOf(second));
});

test('npm mutations revalidate the exact qualified Nightly predecessor', () => {
  const nightly = readWorkflow('npm-publication.yml');
  const nightlyFence = namedStep(
    workflowSteps(nightly),
    'Require the qualified predecessor and Nightly channel advance',
  );
  assert.match(nightlyFence, /needs\.cli\.outputs\.release_predecessor_version/u);
  assert.match(nightlyFence, /needs\.cli\.outputs\.release_predecessor_integrity/u);
  assert.match(nightlyFence, /assert-nightly-predecessor/u);
  assert.ok(nightly.indexOf(nightlyFence) < nightly.indexOf('npm publish'));

  const stage = readWorkflow('release-cli-stage.yml');
  const submit = namedStep(workflowSteps(stage), 'Submit the candidate to npm staging');
  assert.match(submit, /needs\.validate\.outputs\.release_predecessor_version/u);
  assert.match(submit, /needs\.validate\.outputs\.release_predecessor_integrity/u);
  assert.match(submit, /assert-nightly-predecessor/u);
  assert.ok(submit.indexOf('assert-nightly-predecessor') < submit.indexOf('npm stage publish'));
});

test('stage consumes the validated artifact and makes provenance staging the final step', () => {
  const workflow = readWorkflow('release-cli-stage.yml');
  assert.match(workflow, /environment:\n\s+name: npm-publication/u);
  const steps = workflowSteps(workflow);
  const download = namedStep(steps, 'Download the validated release candidate');
  assert.match(
    download,
    /artifact-ids: \$\{\{ needs\.validate\.outputs\.release_candidate_artifact_id \}\}/u,
  );
  assert.match(workflow, /RELEASE_RUN_ATTEMPT/u);
  namedStep(steps, 'Record the post-staging approval step');
  const submit = namedStep(steps, 'Submit the candidate to npm staging');
  assert.equal(steps.at(-1), submit);
  assert.match(submit, /product-release-authority\.mjs verify-draft/u);
  assert.ok(submit.indexOf('verify-draft') < submit.indexOf('npm stage publish'));
  assert.match(submit, /npm stage publish/u);
  assert.match(submit, /--provenance/u);
});

test('stage builds product data without executing it under npm OIDC', () => {
  const workflow = readWorkflow('release-cli-stage.yml');
  const authorize = workflow.slice(
    workflow.indexOf('\n  authorize:'),
    workflow.indexOf('\n  validate:'),
  );
  const authorizeSteps = workflowSteps(authorize);
  const checkouts = authorizeSteps.filter((step) => step.includes('uses: actions/checkout@'));
  assert.equal(checkouts.length, 2);
  assert.match(checkouts[0], /ref: \$\{\{ github\.sha \}\}/u);
  assert.match(checkouts[1], /ref: v\$\{\{ inputs\.version \}\}/u);
  assert.match(checkouts[1], /path: product-source/u);
  assert.match(workflow, /RELEASE_REF.*refs\/heads\/main/su);
  assert.match(workflow, /source_commit: \$\{\{ steps\.product\.outputs\.source_commit \}\}/u);
  assert.match(
    workflow,
    /needs: authorize\n\s+uses: \.\/\.github\/workflows\/cli-package-validation\.yml/u,
  );
  assert.match(workflow, /source_commit: \$\{\{ needs\.authorize\.outputs\.source_commit \}\}/u);
  const stageCheckout = namedStep(workflowSteps(workflow), 'Check out trusted staging code');
  assert.match(stageCheckout, /ref: \$\{\{ github\.sha \}\}/u);
  assert.match(workflow, /product-release-authority\.mjs verify-draft/u);
  assert.match(workflow, /EXPECTED_PRODUCT_VERSION/u);
  assert.doesNotMatch(workflow, /EXPECTED_PRODUCT_TAG|EXPECTED_PRODUCT_SOURCE_COMMIT/u);
  assert.match(
    workflow,
    /PRODUCT_SOURCE_SHA: \$\{\{ needs\.authorize\.outputs\.source_commit \}\}/u,
  );
  assert.match(workflow, /PUBLISHER_SHA: \$\{\{ github\.sha \}\}/u);
  assert.match(workflow, /RELEASE_WORKFLOW: \.github\/workflows\/npm-publication\.yml/u);
  const bind = namedStep(workflowSteps(workflow), 'Bind the candidate to this workflow run');
  assert.match(bind, /PRODUCT_TAG: \$\{\{ needs\.authorize\.outputs\.product_tag \}\}/u);
});

test('finalize runs the current verifier from reviewed main against exact build evidence', () => {
  const workflow = readWorkflow('release-cli-finalize.yml');
  const steps = workflowSteps(workflow);
  assert.match(workflow, /stage_run_attempt:[\s\S]*?required: true/u);
  const loadIndex = workflow.indexOf('name: Load the exact stage workflow run');
  const checkoutIndex = workflow.indexOf('uses: actions/checkout@');
  assert.ok(loadIndex >= 0 && checkoutIndex > loadIndex);
  assert.match(workflow, /actions\/runs\/\$STAGE_RUN_ID\/attempts\/\$STAGE_RUN_ATTEMPT/u);
  assert.match(workflow, /release_run_attempt:[\s\S]*?required: true/u);
  assert.match(workflow, /actions\/runs\/\$RELEASE_RUN_ID\/attempts\/\$RELEASE_RUN_ATTEMPT/u);
  const checkout = namedStep(steps, 'Check out the current release verifier');
  assert.match(checkout, /ref: \$\{\{ github\.sha \}\}/u);
  const requireMain = namedStep(steps, 'Require main');
  assert.match(requireMain, /refs\/heads\/main/u);
});

test('finalize revalidates the live product release before trusting public npm bytes', () => {
  const workflow = readWorkflow('release-cli-finalize.yml');
  const steps = workflowSteps(workflow);
  const record = namedStep(steps, 'Verify the stage run and release record');
  assert.match(record, /id: release/u);
  assert.match(record, /"\$GITHUB_OUTPUT"/u);
  const authority = namedStep(steps, 'Revalidate the product release authority');
  assert.match(authority, /product-release-authority\.mjs verify-build-run/u);
  assert.match(authority, /product-release-artifacts\.mjs inspect-record/u);
  assert.match(authority, /product-release-authority\.mjs verify-draft/u);
  assert.ok(
    workflow.indexOf(authority) < workflow.indexOf('Fetch and verify the public registry bytes'),
  );
});

test('finalize preserves npm evidence and owns the single product publication boundary', () => {
  const workflow = readWorkflow('release-cli-finalize.yml');
  const steps = workflowSteps(workflow);
  assert.match(workflow, /name: Preserve the verified public npm package/u);
  assert.match(workflow, /path: \$\{\{ runner\.temp \}\}\/registry-release/u);
  assert.doesNotMatch(workflow, /cli-v/u);
  assert.match(workflow, /name: product-release/u);
  assert.match(workflow, /contents: write/u);
  assert.match(workflow, /id-token: write/u);
  assert.match(workflow, /attestations: write/u);
  assert.match(workflow, /product-release-authority\.mjs publish-draft/u);
  assert.match(workflow, /actions\/attest@[0-9a-f]{40}/u);
  const artifacts = namedStep(steps, 'Download the exact verified Release run artifacts');
  assert.match(artifacts, /run-id: \$\{\{ needs\.inspect\.outputs\.release_run_id \}\}/u);
  const preflight = namedStep(steps, 'Verify the exact publication input');
  const attest = steps.find((step) => step.includes('uses: actions/attest@'));
  const verify = namedStep(steps, 'Verify the issued provenance');
  const publish = namedStep(steps, 'Publish the verified convenience release');
  assert.ok(attest);
  assert.ok(
    workflow.indexOf(preflight) < workflow.indexOf(attest) &&
      workflow.indexOf(attest) < workflow.indexOf(verify) &&
      workflow.indexOf(verify) < workflow.indexOf(publish),
  );
  assert.match(preflight, /product-release-authority\.mjs verify-publication/u);
  assert.match(verify, /gh attestation verify/u);
  assert.match(verify, /@refs\/heads\/main/u);
  assert.doesNotMatch(workflow.slice(workflow.indexOf('\n  publish:')), /\$\{\{ inputs\./u);
});

test('finalize consumes the normalized release assets the publish job hands off', () => {
  // The runner uploads still carry the per-architecture macOS feeds that the
  // Release publish job merges into the one feed clients read. Reassembling
  // them here would attest and check a set the release never carries, so
  // Finalize takes the single artifact holding the verified published bytes.
  const finalize = readWorkflow('release-cli-finalize.yml');
  const steps = workflowSteps(finalize);
  const download = namedStep(steps, 'Download the exact verified Release run artifacts');
  const [, artifact] =
    /\n\s+name: (\S+)-\$\{\{ needs\.inspect\.outputs\.release_run_attempt \}\}/u.exec(download);
  assert.doesNotMatch(download, /pattern:|merge-multiple:/u);
  assert.match(
    readWorkflow('release.yml'),
    new RegExp(
      `\\n\\s+name: ${artifact}-\\$\\{\\{ github\\.run_attempt \\}\\}\\n\\s+path: release-assets\\n`,
      'u',
    ),
  );

  // Everything downstream reads the one directory that download populates.
  const attest = steps.find((step) => step.includes('uses: actions/attest@'));
  assert.match(attest, /subject-path: \$\{\{ runner\.temp \}\}\/product-release\/\*/u);
  const preflight = namedStep(steps, 'Verify the exact publication input');
  assert.match(preflight, /"\$RUNNER_TEMP\/product-release"/u);
  const verify = namedStep(steps, 'Verify the issued provenance');
  assert.match(verify, /find "\$RUNNER_TEMP\/product-release"/u);
});

test('release workflows select npm from the root packageManager authority', () => {
  for (const name of [
    'cli-package-validation.yml',
    'npm-publication.yml',
    'release-cli-stage.yml',
    'release-cli-finalize.yml',
  ]) {
    const workflow = readWorkflow(name);
    assert.doesNotMatch(workflow, /npm@11\.19\.0/u);
    const selectors = workflowSteps(workflow).filter((step) =>
      /name: Select the .*npm toolchain/u.test(step),
    );
    assert.ok(selectors.length > 0, `${name} has no npm toolchain selector`);
    for (const step of selectors) {
      assert.match(step, /require\("\.\/package\.json"\)\.packageManager/u);
    }
  }
});

function readWorkflow(name) {
  return readFileSync(resolve(workflows, name), 'utf8');
}

function workflowSteps(workflow) {
  const starts = [...workflow.matchAll(/^      - (?=name:|uses:)/gmu)].map((match) => match.index);
  return starts.map((start, index) => workflow.slice(start, starts[index + 1]));
}

function namedStep(steps, name) {
  const step = steps.find((candidate) => candidate.startsWith(`      - name: ${name}\n`));
  assert.ok(step, `missing workflow step: ${name}`);
  return step;
}
