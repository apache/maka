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
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { parse } from 'yaml';

async function readUpkeepWorkflow() {
  return parse(
    await readFile(
      new URL('../.github/workflows/model-metadata-upkeep.yml', import.meta.url),
      'utf8',
    ),
  );
}

async function readRootScripts() {
  return JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).scripts;
}

function stepNamed(workflow, name) {
  const step = workflow.jobs.refresh.steps.find((candidate) => candidate.name === name);
  assert.ok(step, `missing step: ${name}`);
  return step;
}

test('upkeep runs on a weekly schedule and never against a pull request', async () => {
  const workflow = await readUpkeepWorkflow();
  assert.deepEqual(Object.keys(workflow.on).toSorted(), ['schedule', 'workflow_dispatch']);
  assert.equal(workflow.on.schedule.length, 1);
  const [minute, hour, dayOfMonth, month, dayOfWeek] = workflow.on.schedule[0].cron.split(' ');
  // A single weekday with a fixed hour is the weekly cadence. Runners are a
  // shared foundation resource and every daily run costs a queue slot.
  assert.match(dayOfWeek, /^[0-6]$/u);
  assert.deepEqual([dayOfMonth, month], ['*', '*']);
  assert.doesNotMatch(minute, /^[*0]$/u);
  assert.match(hour, /^\d+$/u);
});

test('only the scheduled job writes, and only on the canonical repository', async () => {
  const workflow = await readUpkeepWorkflow();
  assert.deepEqual(workflow.permissions, { contents: 'read' });
  assert.deepEqual(workflow.jobs.refresh.permissions, {
    contents: 'write',
    'pull-requests': 'write',
  });
  assert.match(workflow.jobs.refresh.if, /github\.repository == 'apache\/maka'/u);
  assert.equal(Object.keys(workflow.jobs).length, 1);
  assert.equal(stepNamed(workflow, 'Check out the repository').with['persist-credentials'], false);
});

test('the refresh reports drift first and refuses to waive upstream removals', async () => {
  const workflow = await readUpkeepWorkflow();
  const order = [
    'Report snapshot drift against models.dev',
    'Refresh the snapshot from models.dev',
  ].map((name) => workflow.jobs.refresh.steps.findIndex((step) => step.name === name));
  assert.ok(order.every((position) => position >= 0));
  assert.ok(order[0] < order[1]);
  assert.equal(
    stepNamed(workflow, 'Report snapshot drift against models.dev')['continue-on-error'],
    true,
  );
  assert.doesNotMatch(JSON.stringify(workflow), /--accept-upstream-removals/u);
});

test('the pull request is opened for review and never merged by the job', async () => {
  const workflow = await readUpkeepWorkflow();
  const open = stepNamed(workflow, 'Open the review pull request');
  assert.match(open.run, /gh pr create --draft/u);
  assert.doesNotMatch(JSON.stringify(workflow), /gh pr merge|--auto\b|--admin\b/u);
});

test('the drift check stays out of the checks that run on every pull request', async () => {
  const scripts = await readRootScripts();
  assert.equal(
    scripts['check:model-metadata-drift'],
    'node scripts/sync-model-metadata.mjs --drift',
  );
  // Reaching models.dev is not a precondition for reviewing a pull request.
  for (const gate of ['check:asf-source', 'check:release']) {
    assert.doesNotMatch(scripts[gate], /check:model-metadata-drift|--drift/u);
  }
  assert.match(scripts['check:asf-source'], /model-metadata-upkeep-workflow-policy\.test\.mjs/u);
});
