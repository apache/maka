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
import { describe, it } from 'node:test';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createReadOnlyPermissionProfile,
  createWorkspaceWritePermissionProfile,
} from '@maka/core/permission-profile';

import {
  resolveMacosCommandPaths,
  resolveMacosDeveloperExecutableRoots,
} from '../sandbox/macos-command-paths.js';

describe('resolveMacosDeveloperExecutableRoots', () => {
  it('accepts canonical and symlinked CommandLineTools layouts', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'maka-clt-'));
    const developer = join(scratch, 'CommandLineTools');
    const library = join(developer, 'usr', 'lib');
    const alias = join(scratch, 'selected');
    mkdirSync(library, { recursive: true });
    writeFileSync(join(library, 'libxcrun.dylib'), 'fixture');
    symlinkSync(developer, alias);
    try {
      assert.deepEqual(
        resolveMacosDeveloperExecutableRoots({
          developerDir: developer,
          validateAppleBinary: () => true,
        }),
        [realpathSync(library)],
      );
      assert.deepEqual(
        resolveMacosDeveloperExecutableRoots({
          developerDir: alias,
          validateAppleBinary: () => true,
        }),
        [realpathSync(library)],
      );
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it('accepts only the library and SharedFrameworks directories from an Xcode layout', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'maka-xcode-'));
    const contents = join(scratch, 'Xcode-beta.app', 'Contents');
    const developer = join(contents, 'Developer');
    const library = join(developer, 'usr', 'lib');
    const frameworks = join(contents, 'SharedFrameworks');
    mkdirSync(library, { recursive: true });
    mkdirSync(frameworks);
    writeFileSync(join(library, 'libxcrun.dylib'), 'fixture');
    try {
      assert.deepEqual(
        resolveMacosDeveloperExecutableRoots({
          developerDir: developer,
          validateAppleBinary: () => true,
        }),
        [realpathSync(library), realpathSync(frameworks)],
      );
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it('rejects root, home, ordinary directories, and unresolved symlinks', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'maka-invalid-developer-'));
    const ordinary = join(scratch, 'ordinary');
    const dangling = join(scratch, 'dangling');
    mkdirSync(ordinary);
    symlinkSync(join(scratch, 'missing'), dangling);
    try {
      assert.deepEqual(resolveMacosDeveloperExecutableRoots({ developerDir: '/' }), []);
      assert.deepEqual(
        resolveMacosDeveloperExecutableRoots({ developerDir: scratch, homeDir: scratch }),
        [],
      );
      assert.deepEqual(resolveMacosDeveloperExecutableRoots({ developerDir: ordinary }), []);
      assert.deepEqual(resolveMacosDeveloperExecutableRoots({ developerDir: dangling }), []);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it('uses DEVELOPER_DIR before consulting xcode-select', () => {
    let selected = false;
    resolveMacosDeveloperExecutableRoots({
      developerDir: '/',
      selectDeveloperDir: () => {
        selected = true;
        return undefined;
      },
    });
    assert.equal(selected, false);
  });

  it('returns a canonical root that is unaffected by later selector alias replacement', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'maka-replaced-selection-'));
    const first = join(scratch, 'first', 'CommandLineTools');
    const second = join(scratch, 'second', 'CommandLineTools');
    const alias = join(scratch, 'selected');
    for (const developer of [first, second]) {
      const library = join(developer, 'usr', 'lib');
      mkdirSync(library, { recursive: true });
      writeFileSync(join(library, 'libxcrun.dylib'), 'fixture');
    }
    symlinkSync(first, alias);
    try {
      const roots = resolveMacosDeveloperExecutableRoots({
        developerDir: alias,
        validateAppleBinary: () => true,
      });
      unlinkSync(alias);
      symlinkSync(second, alias);
      assert.deepEqual(roots, [realpathSync(join(first, 'usr', 'lib'))]);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it('rejects a structurally plausible toolchain whose libxcrun is not Apple-signed', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'maka-unsigned-clt-'));
    const developer = join(scratch, 'CommandLineTools');
    const library = join(developer, 'usr', 'lib');
    mkdirSync(library, { recursive: true });
    writeFileSync(join(library, 'libxcrun.dylib'), 'not signed');
    try {
      assert.deepEqual(resolveMacosDeveloperExecutableRoots({ developerDir: developer }), []);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});

describe('resolveMacosCommandPaths', () => {
  it('does not add selected developer roots to restricted read-only profiles', () => {
    let validated = false;
    const scratch = mkdtempSync(join(tmpdir(), 'maka-read-only-toolchain-'));
    const developer = join(scratch, 'CommandLineTools');
    const library = join(developer, 'usr', 'lib');
    mkdirSync(library, { recursive: true });
    writeFileSync(join(library, 'libxcrun.dylib'), 'fixture');
    try {
      assert.deepEqual(
        resolveMacosCommandPaths(
          createReadOnlyPermissionProfile(),
          { DEVELOPER_DIR: developer },
          {
            validateAppleBinary: () => {
              validated = true;
              return true;
            },
          },
        ),
        { executableRoots: [] },
      );
      assert.equal(validated, false);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it('adds only validated developer roots to writable command profiles', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'maka-writable-toolchain-'));
    const developer = join(scratch, 'CommandLineTools');
    const library = join(developer, 'usr', 'lib');
    mkdirSync(library, { recursive: true });
    writeFileSync(join(library, 'libxcrun.dylib'), 'fixture');
    try {
      assert.deepEqual(
        resolveMacosCommandPaths(
          createWorkspaceWritePermissionProfile(),
          { DEVELOPER_DIR: developer },
          { validateAppleBinary: () => true },
        ),
        { executableRoots: [realpathSync(library)] },
      );
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});
