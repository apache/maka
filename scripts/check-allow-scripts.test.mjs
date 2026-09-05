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
import test from 'node:test';
import {
  assertNoUnusedEntries,
  inspectAllowScripts,
  npmInvocation,
  parsePruneReport,
} from './check-allow-scripts.mjs';

const cleanOutput = JSON.stringify({
  allowScripts: { removed: [], dryRun: true },
});

test('uses the npm CLI that launched the package script', () => {
  assert.deepEqual(
    npmInvocation({ npmExecPath: '/tools/npm-cli.js', execPath: '/tools/node', platform: 'linux' }),
    {
      command: '/tools/node',
      args: ['/tools/npm-cli.js', 'install-scripts', 'prune', '--dry-run', '--json'],
    },
  );
});

test('falls back to npm on PATH for direct node runs', () => {
  assert.deepEqual(npmInvocation(), {
    command: 'npm',
    args: ['install-scripts', 'prune', '--dry-run', '--json'],
  });
});

test('parses a dry-run prune report', () => {
  assert.deepEqual(parsePruneReport(cleanOutput), { removed: [], dryRun: true });
});

test('rejects malformed or mutating prune output', () => {
  assert.throws(() => parsePruneReport('not json'), /did not return valid JSON/);
  assert.throws(
    () => parsePruneReport(JSON.stringify({ allowScripts: { removed: [], dryRun: false } })),
    /unexpected JSON shape/,
  );
  assert.throws(
    () =>
      parsePruneReport(
        JSON.stringify({
          allowScripts: {
            removed: [{ key: 'pkg@1.0.0', value: true, reason: 'unexpected' }],
            dryRun: true,
          },
        }),
      ),
    /invalid removed entry/,
  );
});

test('runs npm in dry-run mode without mutating package.json', () => {
  const calls = [];
  const report = inspectAllowScripts({
    cwd: '/workspace',
    env: { npm_execpath: '/tools/npm-cli.js' },
    execPath: '/tools/node',
    platform: 'linux',
    spawn(command, args, options) {
      calls.push({ command, args, options });
      return { status: 0, stdout: cleanOutput, stderr: '' };
    },
  });

  assert.deepEqual(report, { removed: [], dryRun: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, '/tools/node');
  assert.deepEqual(calls[0].args, [
    '/tools/npm-cli.js',
    'install-scripts',
    'prune',
    '--dry-run',
    '--json',
  ]);
  assert.equal(calls[0].options.cwd, '/workspace');
  assert.equal(calls[0].options.env.npm_config_update_notifier, 'false');
  assert.equal(calls[0].options.shell, undefined);
});

test('uses the repository npm shell rule for direct Windows runs', () => {
  const calls = [];
  inspectAllowScripts({
    env: {},
    platform: 'win32',
    spawn(command, args, options) {
      calls.push({ command, args, options });
      return { status: 0, stdout: cleanOutput, stderr: '' };
    },
  });

  assert.equal(calls[0].command, 'npm');
  assert.equal(calls[0].options.shell, true);
});

test('surfaces npm failures with the required-toolchain guidance', () => {
  assert.throws(
    () =>
      inspectAllowScripts({
        env: {},
        platform: 'linux',
        spawn() {
          return { status: 1, stdout: '', stderr: 'Unknown command: install-scripts' };
        },
      }),
    /Use the npm version declared in package\.json\.\nUnknown command: install-scripts/,
  );
});

test('reports every unused approval and denial', () => {
  assert.throws(
    () =>
      assertNoUnusedEntries({
        removed: [
          { key: 'esbuild@0.27.7', value: true, reason: 'not-installed' },
          { key: 'old-denial', value: false, reason: 'no-scripts' },
        ],
        dryRun: true,
      }),
    (error) => {
      assert.match(error.message, /2 unused allowScripts entries/);
      assert.match(error.message, /esbuild@0\.27\.7 \(package not installed\)/);
      assert.match(error.message, /old-denial \(package has no install scripts\)/);
      return true;
    },
  );
});
