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
    step.includes('uses: actions/download-artifact@'),
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
  const steps = workflowSteps(workflow);
  const download = namedStep(steps, 'Download the validated release candidate');
  assert.match(
    download,
    /artifact-ids: \$\{\{ needs\.validate\.outputs\.release_candidate_artifact_id \}\}/u,
  );
  assert.match(workflow, /RELEASE_RUN_ATTEMPT/u);
  const guidance = namedStep(steps, 'Record the post-staging approval step');
  assert.match(guidance, /if \[\[ "\$RELEASE_DIST_TAG" == "latest" \]\]/u);
  assert.match(guidance, /npm dist-tag add/u);
  const submit = namedStep(steps, 'Submit the candidate to npm staging');
  assert.equal(steps.at(-1), submit);
  assert.match(submit, /product-release-authority\.mjs verify-draft/u);
  assert.ok(submit.indexOf('verify-draft') < submit.indexOf('npm stage publish'));
  assert.match(submit, /npm stage publish/u);
  assert.match(submit, /--provenance/u);
});

test('stage builds the npm candidate from the exact product release commit', () => {
  const workflow = readWorkflow('release-cli-stage.yml');
  const authorizeSteps = workflowSteps(workflow);
  const checkout = authorizeSteps.find((step) => step.includes('uses: actions/checkout@'));
  assert.match(checkout, /ref: v\$\{\{ inputs\.version \}\}/u);
  assert.match(workflow, /RELEASE_REF.*refs\/tags\/\$PRODUCT_TAG/su);
  assert.match(workflow, /source_commit: \$\{\{ steps\.product\.outputs\.source_commit \}\}/u);
  assert.match(
    workflow,
    /needs: authorize\n\s+uses: \.\/\.github\/workflows\/cli-package-validation\.yml/u,
  );
  assert.match(workflow, /source_commit: \$\{\{ needs\.authorize\.outputs\.source_commit \}\}/u);
  assert.match(workflow, /ref: \$\{\{ needs\.authorize\.outputs\.source_commit \}\}/u);
  assert.match(workflow, /product-release-authority\.mjs verify-draft/u);
  assert.match(workflow, /EXPECTED_PRODUCT_VERSION/u);
  assert.doesNotMatch(workflow, /EXPECTED_PRODUCT_TAG|EXPECTED_PRODUCT_SOURCE_COMMIT/u);
  assert.match(workflow, /RELEASE_SHA: \$\{\{ github\.sha \}\}/u);
  const bind = namedStep(workflowSteps(workflow), 'Bind the candidate to this workflow run');
  assert.match(bind, /PRODUCT_TAG: \$\{\{ needs\.authorize\.outputs\.product_tag \}\}/u);
});

test('finalize validates one exact stage attempt before running the current verifier', () => {
  const workflow = readWorkflow('release-cli-finalize.yml');
  const steps = workflowSteps(workflow);
  assert.match(workflow, /stage_run_attempt:[\s\S]*?required: true/u);
  const loadIndex = workflow.indexOf('name: Load the exact stage workflow run');
  const checkoutIndex = workflow.indexOf('uses: actions/checkout@');
  assert.ok(loadIndex >= 0 && checkoutIndex > loadIndex);
  assert.match(workflow, /actions\/runs\/\$STAGE_RUN_ID\/attempts\/\$STAGE_RUN_ATTEMPT/u);
  const checkout = namedStep(steps, 'Check out the current release verifier');
  assert.match(checkout, /ref: \$\{\{ github\.sha \}\}/u);
});

test('finalize revalidates the live product release before trusting public npm bytes', () => {
  const workflow = readWorkflow('release-cli-finalize.yml');
  const steps = workflowSteps(workflow);
  const record = namedStep(steps, 'Verify the stage run and release record');
  assert.match(record, /id: release/u);
  assert.match(record, /"\$GITHUB_OUTPUT"/u);
  const authority = namedStep(steps, 'Revalidate the product release authority');
  assert.match(authority, /product-release-authority\.mjs verify-draft/u);
  assert.ok(
    workflow.indexOf(authority) < workflow.indexOf('Fetch and verify the public registry bytes'),
  );
});

test('finalize preserves verified npm bytes without creating another product release', () => {
  const workflow = readWorkflow('release-cli-finalize.yml');
  assert.match(workflow, /name: Preserve the verified public npm package/u);
  assert.match(workflow, /path: \$\{\{ runner\.temp \}\}\/registry-release/u);
  assert.doesNotMatch(workflow, /cli-v|contents: write/u);
});

test('release workflows select npm from the root packageManager authority', () => {
  for (const name of [
    'cli-package-validation.yml',
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
