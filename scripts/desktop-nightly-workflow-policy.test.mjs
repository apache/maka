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
import { desktopNightlyTargets } from './desktop-nightly.mjs';

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
  assert.equal(upload.with.name, 'desktop-nightly-${{ matrix.platform }}-${{ matrix.arch }}');
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
  // The runner never names its own uploads; the target descriptor does.
  assert.match(stage.run, /desktop-nightly\.mjs stage-target/u);
  assert.match(stage.run, /\$\{\{ matrix\.platform \}\}-\$\{\{ matrix\.arch \}\}/u);
  assert.doesNotMatch(JSON.stringify(workflow), /latest-mac\.yml|latest\.yml/u);
  // Nor does it name a distributable: the descriptor does, and the verifiers
  // read it from there.
  assert.doesNotMatch(JSON.stringify(workflow), /win-x64\.exe/u);
});

test('every packaged Desktop target ships from a runner of its own architecture', async () => {
  const workflow = await readWorkflow('desktop-nightly.yml');
  const targets = workflow.jobs.desktop.strategy.matrix.include;
  const names = targets.map((entry) => `${entry.platform}-${entry.arch}`);
  assert.deepEqual(names, ['macos-arm64', 'macos-x64', 'windows-x64', 'linux-x64', 'linux-arm64']);
  const nightlyTargets = desktopNightlyTargets('0.2.0-dev.42.20260829').map(
    (target) => target.name,
  );
  assert.deepEqual(names.toSorted(), nightlyTargets.toSorted());
  // The runner image is the workflow's to choose; what it may not do is choose
  // one that disagrees with the row it builds. The native Runtime Host peer is
  // never cross-built, so every row runs on its own platform and architecture.
  for (const { platform, arch, runner } of targets) {
    if (platform === 'macos') {
      assert.match(runner, /^macos-/u);
      assert.equal(runner.endsWith('-intel'), arch === 'x64', runner);
    } else if (platform === 'windows') {
      assert.match(runner, /^windows-/u);
    } else {
      assert.match(runner, /^ubuntu-/u);
      assert.equal(runner.endsWith('-arm'), arch === 'arm64', runner);
    }
  }
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

test('the Nightly Linux verification runs under a virtual display', async () => {
  // The last thing `verify:linux` does is launch the extracted AppImage's
  // renderer. A headless runner has no display, so a step that dropped
  // `xvfb-run` would fail every Nightly at its slowest point.
  const workflow = await readWorkflow('desktop-nightly.yml');
  const steps = Object.values(workflow.jobs)
    .flatMap((job) => job.steps ?? [])
    .filter((step) => typeof step.run === 'string' && step.run.includes('npm run verify:linux'));

  assert.equal(steps.length, 1);
  for (const step of steps) {
    assert.match(step.run, /^xvfb-run\b/u, step.name);
  }
});

test('Desktop Nightly has no Apache Nightlies transport or compatibility state', async () => {
  const workflow = await readWorkflow('desktop-nightly.yml');
  assert.equal(workflow.jobs.publish.environment, 'nightly');
  assert.doesNotMatch(
    JSON.stringify(workflow),
    /nightlies\.apache\.org|NIGHTLIES_RSYNC|resolve-cutover|github-cutover|\brsync\b|\bssh\b/u,
  );
});
