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
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { createRuntimeHostSetupPackageResolver } from '../runtime-host-setup-package.js';

test('development setup lazily builds one local CLI archive unless explicitly overridden', async () => {
  const repoRoot = resolve('/workspace');
  const archive = join(repoRoot, 'packages', 'cli', 'release', 'maka-agent-dev.tgz');
  let builds = 0;
  const resolvePackage = createRuntimeHostSetupPackageResolver({
    isPackaged: false,
    appPath: join(repoRoot, 'apps', 'desktop'),
    environment: {},
    buildDevelopmentArchive: async (resolvedRoot) => {
      builds += 1;
      assert.equal(resolvedRoot, repoRoot);
      return archive;
    },
  });

  assert.deepEqual(await Promise.all([resolvePackage(), resolvePackage()]), [
    {
      kind: 'development_archive',
      path: archive,
    },
    {
      kind: 'development_archive',
      path: archive,
    },
  ]);
  assert.equal(builds, 1);

  const override = join(tmpdir(), 'explicit.tgz');
  const resolveOverride = createRuntimeHostSetupPackageResolver({
    isPackaged: false,
    appPath: join(repoRoot, 'apps', 'desktop'),
    environment: { MAKA_RUNTIME_HOST_SETUP_ARCHIVE: override },
    buildDevelopmentArchive: async () => assert.fail('override must bypass the local build'),
  });
  assert.deepEqual(await resolveOverride(), {
    kind: 'development_archive',
    path: override,
  });
});
