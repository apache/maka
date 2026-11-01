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

import { appendFileSync, readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { command } from './ci/command.mjs';
import { createPlan, documentation, sharedInput } from './ci/plan.mjs';
import { manifests } from './ci/suites.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));

export async function plan({ baseline = null, event = process.env.GITHUB_EVENT_NAME } = {}) {
  const revision = (
    await command('git', ['rev-parse', 'HEAD'], { cwd: root, capture: true })
  ).trim();
  if (process.env.GITHUB_SHA && revision !== process.env.GITHUB_SHA)
    throw new Error('Checkout differs from the workflow revision');
  if (event === 'pull_request') {
    baseline = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')).pull_request.base
      .sha;
    await command('git', ['fetch', '--no-tags', '--depth=1', 'origin', baseline], { cwd: root });
  }
  const changes =
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
      appendFileSync(
        process.env.GITHUB_OUTPUT,
        `plan=${JSON.stringify(result)}\nroot=${Boolean(result.suites.root)}\nworkers=${JSON.stringify(result.workers)}\n`,
      );
    }
    return;
  }
  throw new Error('Usage: ci.mjs plan [--base REVISION]');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
