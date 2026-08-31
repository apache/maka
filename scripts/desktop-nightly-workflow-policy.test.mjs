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
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { parse } from 'yaml';

async function readWorkflow(name) {
  return parse(await readFile(new URL(`../.github/workflows/${name}`, import.meta.url), 'utf8'));
}

test('npm publication owns both npm channels and no Desktop authority', async () => {
  const workflow = await readWorkflow('npm-publication.yml');
  assert.deepEqual(workflow.concurrency, {
    group: "npm-publication-${{ inputs.channel || 'nightly' }}",
    'cancel-in-progress': false,
  });
  assert.match(workflow.jobs.identity.if, /vars\.NPM_NIGHTLY_ENABLED == 'true'/u);
  assert.equal(workflow.jobs.formal.uses, './.github/workflows/release-cli-stage.yml');
  assert.equal(workflow.jobs.formal.permissions['id-token'], 'write');
  assert.equal(workflow.jobs.cli.uses, './.github/workflows/cli-package-validation.yml');
  assert.equal(workflow.jobs.cli.with.package_version, '${{ needs.identity.outputs.version }}');
  assert.equal(workflow.jobs.publish.environment, 'npm-publication');
  assert.equal(workflow.jobs.publish.permissions['id-token'], 'write');
  const steps = workflow.jobs.publish.steps;
  const positions = [
    'Publish the exact npm Nightly',
    'Require the public npm Nightly',
    'Record the published Product Nightly version',
    'Hand the exact version to Desktop Nightly',
  ].map((name) => steps.findIndex((step) => step.name === name));
  assert.deepEqual(
    positions,
    positions.toSorted((left, right) => left - right),
  );
  assert.ok(positions.every((position) => position >= 0));
  assert.doesNotMatch(JSON.stringify(workflow), /DESKTOP_NIGHTLY_ENABLED|NIGHTLIES_RSYNC/u);
  assert.doesNotMatch(JSON.stringify(workflow), /NODE_AUTH_TOKEN|NPM_TOKEN/u);
});

test('Desktop Nightly starts only from a successful published npm identity', async () => {
  const workflow = await readWorkflow('desktop-nightly.yml');
  assert.deepEqual(workflow.on, {
    workflow_run: {
      workflows: ['npm publication'],
      types: ['completed'],
    },
  });
  assert.match(workflow.jobs.identity.if, /vars\.DESKTOP_NIGHTLY_ENABLED == 'true'/u);
  assert.match(workflow.jobs.identity.if, /workflow_run\.conclusion == 'success'/u);
  assert.match(workflow.jobs.identity.if, /workflow_run\.head_branch == 'main'/u);
  assert.match(workflow.jobs.identity.if, /display_title == 'npm nightly publication'/u);
  const download = workflow.jobs.identity.steps.find(
    (step) => step.name === 'Download the published Nightly version',
  );
  assert.equal(download.with.name, 'product-nightly-version');
  assert.equal(download.with['run-id'], '${{ github.event.workflow_run.id }}');
  const bind = workflow.jobs.identity.steps.find(
    (step) => step.name === 'Bind Desktop to the exact npm Nightly version',
  );
  assert.match(bind.run, /product-nightly\.mjs inspect-version/u);
  assert.equal(
    workflow.jobs.desktop.env.MAKA_DESKTOP_NIGHTLY_VERSION,
    '${{ needs.identity.outputs.version }}',
  );
  assert.doesNotMatch(JSON.stringify(workflow), /npm publish|npm stage publish/u);
});

test('a failed Desktop Nightly is retried through a fresh npm Nightly', async () => {
  const workflow = await readWorkflow('desktop-nightly.yml');
  assert.deepEqual(workflow.concurrency, {
    group: 'desktop-nightly',
    'cancel-in-progress': false,
  });
  for (const jobName of ['identity', 'desktop', 'publish']) {
    const rerunGuard = workflow.jobs[jobName].steps[0];
    assert.equal(rerunGuard.name, 'Reject in-place workflow reruns');
    assert.equal(rerunGuard.if, 'github.run_attempt != 1');
    assert.equal(spawnSync('bash', ['-c', rerunGuard.run]).status, 1);
    assert.match(rerunGuard.run, /fresh npm Nightly dispatch/u);
  }
  const upload = workflow.jobs.desktop.steps.find((step) =>
    step.uses?.startsWith('actions/upload-artifact@'),
  );
  const download = workflow.jobs.publish.steps.find(
    (step) => step.uses?.startsWith('actions/download-artifact@') && step.with?.pattern,
  );
  assert.equal(upload.with.name, 'desktop-nightly-${{ matrix.platform }}');
  assert.equal(download.with.pattern, 'desktop-nightly-*');
});

test('Desktop Nightly packages the GitHub dev feeds and grants write only to its publisher', async () => {
  const workflow = await readWorkflow('desktop-nightly.yml');
  assert.deepEqual(workflow.permissions, { actions: 'read', contents: 'read' });
  assert.equal(workflow.jobs.publish.permissions.contents, 'write');
  assert.equal(workflow.jobs.desktop.permissions, undefined);
  const stage = workflow.jobs.desktop.steps.find(
    (step) => step.name === 'Stage the exact Nightly artifacts',
  );
  assert.match(stage.run, /apps\/desktop\/release\/dev-mac\.yml/u);
  assert.match(stage.run, /apps\/desktop\/release\/dev\.yml/u);
  assert.doesNotMatch(stage.run, /latest-mac\.yml|latest\.yml/u);
});

test('the publisher verifies exact GitHub identity and assets before publishing last', async () => {
  const workflow = await readWorkflow('desktop-nightly.yml');
  const steps = workflow.jobs.publish.steps;
  const positions = [
    'Attest every GitHub Nightly asset subject',
    'Verify the issued Nightly provenance',
    'Add the one offline provenance bundle',
    'Ensure the exact versioned Nightly tag',
    'Prepare and verify the draft GitHub Prerelease',
    'Publish the complete GitHub Prerelease',
  ].map((name) => steps.findIndex((step) => step.name === name));
  assert.ok(positions.every((position) => position >= 0));
  assert.deepEqual(
    positions,
    positions.toSorted((left, right) => left - right),
  );
  assert.match(steps[positions[0]].with['subject-path'], /\.nightly-stage\/release\/\*/u);
  assert.match(steps[positions[3]].run, /product-release-tag\.mjs ensure/u);
  assert.match(steps[positions[4]].run, /desktop-nightly-release\.mjs prepare/u);
  assert.match(steps[positions[5]].run, /desktop-nightly-release\.mjs publish/u);
  assert.equal(
    steps[positions[1]].env.CERTIFICATE_IDENTITY,
    'https://github.com/${{ github.repository }}/.github/workflows/desktop-nightly.yml@refs/heads/main',
  );
});

test('Desktop Nightly has no Apache Nightlies transport or compatibility state', async () => {
  const workflow = await readWorkflow('desktop-nightly.yml');
  assert.equal(workflow.jobs.publish.environment, 'nightly');
  assert.doesNotMatch(
    JSON.stringify(workflow),
    /nightlies\.apache\.org|NIGHTLIES_RSYNC|resolve-cutover|github-cutover|\brsync\b|\bssh\b/u,
  );
});
