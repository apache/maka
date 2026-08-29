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
