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
import { createHash } from 'node:crypto';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  RuntimeHostUpdatePackageError,
  withRuntimeHostRegistryUpdatePackage,
} from '../runtime-host-update-package.js';

const ARCHIVE = Buffer.from('verified release archive');
const INTEGRITY = `sha512-${createHash('sha512').update(ARCHIVE).digest('base64')}`;

describe('managed Runtime Host update package acquisition', () => {
  it('binds the official archive to its extracted release evidence', async () => {
    const calls: string[][] = [];
    const candidate = {
      kind: 'npm_registry' as const,
      version: '2.0.0',
      integrity: INTEGRITY,
      compatibility: 7,
    };
    let acquiredRoot = '';
    await withRuntimeHostRegistryUpdatePackage(
      candidate,
      async (root) => {
        acquiredRoot = root;
        assert.equal((await stat(root)).isDirectory(), true);
      },
      async (args) => {
        calls.push([...args]);
        if (args[0] === 'pack') {
          const destination = args[args.indexOf('--pack-destination') + 1]!;
          await writeFile(join(destination, 'maka-agent-2.0.0.tgz'), ARCHIVE);
          return 0;
        }
        const prefix = args[args.indexOf('--prefix') + 1]!;
        const root = join(prefix, 'node_modules', 'maka-agent');
        await Promise.all([
          mkdir(join(root, 'dist'), { recursive: true }),
          mkdir(join(root, 'node_modules', '@maka', 'runtime-host'), {
            recursive: true,
          }),
        ]);
        await Promise.all([
          writeFile(
            join(root, 'package.json'),
            JSON.stringify({
              name: 'maka-agent',
              version: candidate.version,
              maka: {
                managedRuntimeHostUpdateCompatibility: candidate.compatibility,
              },
            }),
          ),
          writeFile(join(root, 'dist', 'cli.js'), ''),
          writeFile(join(root, 'node_modules', '@maka', 'runtime-host', 'package.json'), '{}'),
        ]);
        return 0;
      },
    );

    assert.deepEqual(calls[0]?.slice(0, 2), ['pack', 'maka-agent@2.0.0']);
    assert.equal(calls[0]?.includes('https://registry.npmjs.org/'), true);
    const downloadCache = calls[0]?.[calls[0].indexOf('--cache') + 1];
    const installCache = calls[1]?.[calls[1].indexOf('--cache') + 1];
    assert.match(downloadCache ?? '', /download-cache$/u);
    assert.match(installCache ?? '', /empty-cache$/u);
    assert.notEqual(downloadCache, installCache);
    assert.equal(calls[1]?.includes('--offline'), true);
    assert.equal(calls[1]?.includes('--ignore-scripts'), true);
    assert.equal(calls[1]?.includes('http://127.0.0.1:9/'), true);
    await assert.rejects(stat(acquiredRoot), { code: 'ENOENT' });
  });

  it('rejects archive or manifest evidence that differs from discovery', async () => {
    let installed = false;
    await assert.rejects(
      withRuntimeHostRegistryUpdatePackage(
        {
          kind: 'npm_registry',
          version: '2.0.0',
          integrity: `sha512-${Buffer.alloc(64).toString('base64')}`,
        },
        async () => assert.fail('invalid integrity must not expose a package'),
        async (args) => {
          if (args[0] === 'pack') {
            const destination = args[args.indexOf('--pack-destination') + 1]!;
            await writeFile(join(destination, 'maka-agent-2.0.0.tgz'), ARCHIVE);
            return 0;
          }
          installed = true;
          return 0;
        },
      ),
      (error: unknown) =>
        error instanceof RuntimeHostUpdatePackageError &&
        error.code === 'package_integrity_mismatch',
    );
    assert.equal(installed, false);

    await assert.rejects(
      withRuntimeHostRegistryUpdatePackage(
        {
          kind: 'npm_registry',
          version: '2.0.0',
          integrity: INTEGRITY,
          compatibility: 7,
        },
        async () => assert.fail('invalid manifest must not expose a package'),
        async (args) => {
          if (args[0] === 'pack') {
            const destination = args[args.indexOf('--pack-destination') + 1]!;
            await writeFile(join(destination, 'maka-agent-2.0.0.tgz'), ARCHIVE);
            return 0;
          }
          const prefix = args[args.indexOf('--prefix') + 1]!;
          const root = join(prefix, 'node_modules', 'maka-agent');
          await Promise.all([
            mkdir(join(root, 'dist'), { recursive: true }),
            mkdir(join(root, 'node_modules', '@maka', 'runtime-host'), {
              recursive: true,
            }),
          ]);
          await Promise.all([
            writeFile(
              join(root, 'package.json'),
              JSON.stringify({
                name: 'maka-agent',
                version: '2.0.0',
                maka: { managedRuntimeHostUpdateCompatibility: 8 },
              }),
            ),
            writeFile(join(root, 'dist', 'cli.js'), ''),
            writeFile(join(root, 'node_modules', '@maka', 'runtime-host', 'package.json'), '{}'),
          ]);
          return 0;
        },
      ),
      (error: unknown) =>
        error instanceof RuntimeHostUpdatePackageError && error.code === 'invalid_package',
    );
  });
});
