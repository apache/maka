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

const workflowPath = new URL('../.github/workflows/desktop-nightly.yml', import.meta.url);

async function readWorkflow() {
  return parse(await readFile(workflowPath, 'utf8'));
}

test('a failed Nightly is retried only as a fresh workflow run', async () => {
  const workflow = await readWorkflow();
  assert.deepEqual(workflow.concurrency, {
    group: 'desktop-nightly',
    'cancel-in-progress': false,
  });
  assert.equal(workflow.jobs.identity.if, "vars.DESKTOP_NIGHTLY_ENABLED == 'true'");
  for (const jobName of ['identity', 'desktop', 'publish']) {
    const rerunGuard = workflow.jobs[jobName].steps[0];
    assert.equal(rerunGuard.name, 'Reject in-place workflow reruns');
    assert.equal(rerunGuard.if, 'github.run_attempt != 1');
    assert.equal(spawnSync('bash', ['-c', rerunGuard.run]).status, 1);
  }
  assert.equal(workflow.jobs.desktop.if, undefined);
  assert.equal(workflow.jobs.publish.if, undefined);
  const upload = workflow.jobs.desktop.steps.find((step) =>
    step.uses?.startsWith('actions/upload-artifact@'),
  );
  const download = workflow.jobs.publish.steps.find((step) =>
    step.uses?.startsWith('actions/download-artifact@'),
  );
  assert.equal(upload.with.name, 'desktop-nightly-${{ matrix.platform }}');
  assert.equal(download.with.pattern, 'desktop-nightly-*');
});

test('the protected publisher appends workspace-staged payloads before advancing the feed', async () => {
  const workflow = await readWorkflow();
  const publish = workflow.jobs.publish;
  assert.equal(publish.environment, 'nightly');
  assert.equal(
    publish.steps.filter((step) => step.uses?.startsWith('burnett01/rsync-deployments@')).length,
    0,
  );
  const transport = publish.steps.find(
    (step) => step.name === 'Prepare authenticated Nightlies SSH transport',
  );
  assert.equal(transport.env.NIGHTLIES_RSYNC_KEY, '${{ secrets.NIGHTLIES_RSYNC_KEY }}');
  assert.equal(
    transport.env.NIGHTLIES_RSYNC_KNOWN_HOSTS,
    '${{ secrets.NIGHTLIES_RSYNC_KNOWN_HOSTS }}',
  );
  assert.match(transport.run, /StrictHostKeyChecking=yes/u);
  assert.doesNotMatch(transport.run, /ssh-keyscan|StrictHostKeyChecking=no/u);
  const transfers = [
    'Publish immutable Nightly payloads',
    'Advance the Nightly update feed last',
  ].map((name) => publish.steps.find((step) => step.name === name));
  assert.deepEqual(
    transfers.map((step) => step.env?.NIGHTLIES_RSYNC_KEY),
    [undefined, undefined],
  );
  for (const step of transfers) {
    assert.match(step.run, /^rsync -rlptDvz --protect-args /u);
    assert.doesNotMatch(step.run, /--delete/u);
  }
});

test('Nightly stays disabled until its external publishing authority is configured', async () => {
  const workflow = await readWorkflow();
  assert.equal(workflow.permissions.contents, 'read');
  assert.equal(workflow.jobs.identity.if, "vars.DESKTOP_NIGHTLY_ENABLED == 'true'");
  const branchGate = workflow.jobs.identity.steps.find(
    (step) => step.name === 'Require the Apache main branch',
  );
  assert.match(branchGate.run, /test "\$GITHUB_REPOSITORY" = apache\/maka/u);
  assert.match(branchGate.run, /test "\$GITHUB_REF" = refs\/heads\/main/u);
  assert.equal(workflow.jobs.desktop.environment, 'nightly');
  assert.equal(workflow.jobs.publish.environment, 'nightly');
});

test('Nightly verifies provenance and advances mutable feeds only after payload upload', async () => {
  const workflow = await readWorkflow();
  const steps = workflow.jobs.publish.steps;
  const positions = [
    'Attest the exact Nightly payloads',
    'Verify the issued Nightly provenance',
    'Publish immutable Nightly payloads',
    'Advance the Nightly update feed last',
  ].map((name) => steps.findIndex((step) => step.name === name));
  assert.deepEqual(
    positions,
    positions.toSorted((left, right) => left - right),
  );
  assert.ok(positions.every((position) => position >= 0));
  const verify = steps[positions[1]];
  assert.equal(
    verify.env.CERTIFICATE_IDENTITY,
    'https://github.com/${{ github.repository }}/.github/workflows/desktop-nightly.yml@refs/heads/main',
  );
  assert.match(verify.run, /gh attestation verify/u);
});
