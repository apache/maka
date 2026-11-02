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

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join, resolve } from 'node:path';
import { command } from './ci/command.mjs';
import { checkResults, createPlan, documentation, sharedInput } from './ci/plan.mjs';
import { manifests, suites, workers } from './ci/suites.mjs';
import { executor } from './ci/run.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const temporary = process.env.RUNNER_TEMP ?? join(root, 'target/ci');
const planFile = join(temporary, 'ci-plan.json');

function output(values) {
  if (process.env.GITHUB_OUTPUT)
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      Object.entries(values)
        .map(
          ([key, value]) => `${key}=${typeof value === 'string' ? value : JSON.stringify(value)}\n`,
        )
        .join(''),
    );
}

export async function plan({ baseline = null, event = process.env.GITHUB_EVENT_NAME } = {}) {
  const revision = (
    await command('git', ['rev-parse', 'HEAD'], { cwd: root, capture: true })
  ).trim();
  if (process.env.GITHUB_SHA && revision !== process.env.GITHUB_SHA)
    throw new Error('Checkout differs from the workflow revision');
  if (event === 'push') {
    baseline = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')).before;
    if (/^0+$/.test(baseline)) baseline = null;
  }
  if (baseline !== null || event === 'pull_request') {
    if (event === 'pull_request')
      baseline = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')).pull_request.base
        .sha;
    await command('git', ['fetch', '--no-tags', '--depth=1', 'origin', baseline], { cwd: root });
  }
  let changes =
    baseline === null
      ? null
      : (
          await command(
            'git',
            ['diff', '--name-only', '--no-renames', '-z', baseline, revision, '--'],
            { cwd: root, capture: true },
          )
        )
          .split('\0')
          .filter(Boolean);
  // Branch pushes retain full coverage; only documentation-only pushes skip work.
  if (event === 'push' && changes?.some((path) => !documentation(path))) changes = null;
  const metadata = {};
  if (changes && !changes.some(sharedInput) && changes.some((path) => !documentation(path))) {
    for (const [workspace, manifest] of Object.entries(manifests)) {
      metadata[workspace] = JSON.parse(
        await command(
          'cargo',
          [
            'metadata',
            '--locked',
            '--format-version',
            '1',
            '--all-features',
            '--manifest-path',
            manifest,
          ],
          { cwd: root, capture: true },
        ),
      );
    }
  }
  return createPlan({ root, changes, metadata, revision, baseline });
}

async function main(args) {
  const [action, ...rest] = args;
  if (action === 'plan') {
    const baseline = rest.length ? rest[1] : null;
    if (rest.length && (rest[0] !== '--base' || rest.length !== 2))
      throw new Error('Usage: ci.mjs plan [--base REVISION]');
    const result = await plan({ baseline });
    console.log(JSON.stringify(result, null, 2));
    if (process.env.GITHUB_OUTPUT) {
      mkdirSync(temporary, { recursive: true });
      writeFileSync(planFile, JSON.stringify(result));
      output({
        root: Boolean(result.suites.root),
        tooling: Boolean(result.suites.tooling),
        workers: result.workers,
      });
    }
    return;
  }
  if (action === 'check') {
    await executor(root).check(rest[0]);
    return;
  }
  if (action === 'run') {
    const [id, ...extra] = rest;
    if (!suites[id]) throw new Error(`Unknown suite: ${id}`);
    const worker = workers.find((entry) => entry.suites.includes(id));
    const run = executor(root, worker);
    await run.prepare(id, suites[id].filter ?? 'all()', extra);
    await run.verify(id, suites[id].filter ?? 'all()', extra);
    return;
  }
  if (action === 'gate') {
    const results = JSON.parse(process.env.MAKA_CI_RESULTS);
    if (results.plan?.result !== 'success') throw new Error('CI planning did not succeed');
    const selected = JSON.parse(readFileSync(planFile, 'utf8'));
    const hasTests = process.env.MAKA_CI_HAS_TESTS;
    checkResults(
      selected,
      results,
      hasTests === '' || hasTests === undefined ? undefined : JSON.parse(hasTests),
    );
    console.log('All planned CI work succeeded');
    return;
  }
  if (action === 'archive') {
    const selected = JSON.parse(readFileSync(planFile, 'utf8'));
    const partitions = await executor(root).archive(
      selected,
      join(temporary, 'root-tests.tar.zst'),
    );
    const version = (await command('cargo', ['nextest', '--version'], { capture: true }))
      .trim()
      .split(/\s+/)[1];
    output({ partitions, has_tests: partitions.length > 0, nextest: version });
    return;
  }
  if (action === 'replay') {
    mkdirSync(join(root, 'target/tmp'), { recursive: true });
    await command(
      'cargo',
      [
        'nextest',
        'run',
        '--archive-file',
        join(temporary, `root-tests-${rest[0]}.tar.zst`),
        '--extract-to',
        root,
        '--extract-overwrite',
        '--profile',
        'ci',
        '--partition',
        rest[1],
      ],
      { cwd: root },
    );
    return;
  }
  if (action === 'prepare' || action === 'verify') {
    const selected = JSON.parse(readFileSync(planFile, 'utf8'));
    const worker = selected.workers.find((entry) => entry.id === rest[0]);
    if (!worker) throw new Error(`Worker not selected: ${rest[0]}`);
    const run = executor(root, worker);
    for (const id of worker.suites) await run[action](id, selected.suites[id].filter);
    return;
  }
  throw new Error('Usage: ci.mjs plan|run|check|prepare|verify|archive|replay|gate');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
