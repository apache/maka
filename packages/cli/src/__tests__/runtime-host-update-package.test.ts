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
  acquireRuntimeHostRegistryUpdatePackage,
  RuntimeHostUpdatePackageError,
} from '../runtime-host-update-package.js';

const ARCHIVE = Buffer.from('verified release archive');
const INTEGRITY = `sha512-${createHash('sha512').update(ARCHIVE).digest('base64')}`;

describe('managed Runtime Host update package acquisition', () => {
  it('binds the official archive to its extracted release evidence', async () => {
    const calls: string[][] = [];
    const candidate = { version: '2.0.0', integrity: INTEGRITY, compatibility: 7 };
    const acquired = await acquireRuntimeHostRegistryUpdatePackage(candidate, async (args) => {
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
        mkdir(join(root, 'node_modules', '@maka', 'runtime-host'), { recursive: true }),
      ]);
      await Promise.all([
        writeFile(
          join(root, 'package.json'),
          JSON.stringify({
            name: 'maka-agent',
            version: candidate.version,
            maka: { managedRuntimeHostUpdateCompatibility: candidate.compatibility },
          }),
        ),
        writeFile(join(root, 'dist', 'cli.js'), ''),
        writeFile(join(root, 'node_modules', '@maka', 'runtime-host', 'package.json'), '{}'),
      ]);
      return 0;
    });

    assert.equal((await stat(acquired.root)).isDirectory(), true);
    assert.deepEqual(calls[0]?.slice(0, 2), ['pack', 'maka-agent@2.0.0']);
    assert.equal(calls[0]?.includes('https://registry.npmjs.org/'), true);
    assert.equal(calls[1]?.includes('--offline'), true);
    assert.equal(calls[1]?.includes('--ignore-scripts'), true);
    assert.equal(calls[1]?.includes('http://127.0.0.1:9/'), true);
    const root = acquired.root;
    await acquired.cleanup();
    await assert.rejects(stat(root), { code: 'ENOENT' });
  });

  it('rejects archive or manifest evidence that differs from discovery', async () => {
    let installed = false;
    await assert.rejects(
      acquireRuntimeHostRegistryUpdatePackage(
        { version: '2.0.0', integrity: `sha512-${Buffer.alloc(64).toString('base64')}` },
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
      acquireRuntimeHostRegistryUpdatePackage(
        { version: '2.0.0', integrity: INTEGRITY, compatibility: 7 },
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
            mkdir(join(root, 'node_modules', '@maka', 'runtime-host'), { recursive: true }),
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
