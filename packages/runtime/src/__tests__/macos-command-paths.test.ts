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
  type MacosDeveloperCommandRunner,
} from '../sandbox/macos-command-paths.js';

describe('resolveMacosDeveloperExecutableRoots', () => {
  it('accepts canonical and symlinked CommandLineTools layouts', async () => {
    const scratch = mkdtempSync(join(tmpdir(), 'maka-clt-'));
    const developer = join(scratch, 'CommandLineTools');
    const library = join(developer, 'usr', 'lib');
    const alias = join(scratch, 'selected');
    mkdirSync(library, { recursive: true });
    writeFileSync(join(library, 'libxcrun.dylib'), 'fixture');
    symlinkSync(developer, alias);
    try {
      assert.deepEqual(
        await resolveMacosDeveloperExecutableRoots({
          developerDir: developer,
          validateAppleBinary: () => true,
        }),
        [realpathSync(library)],
      );
      assert.deepEqual(
        await resolveMacosDeveloperExecutableRoots({
          developerDir: alias,
          validateAppleBinary: () => true,
        }),
        [realpathSync(library)],
      );
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it('accepts only the library and SharedFrameworks directories from an Xcode layout', async () => {
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
        await resolveMacosDeveloperExecutableRoots({
          developerDir: developer,
          validateAppleBinary: () => true,
        }),
        [realpathSync(library), realpathSync(frameworks)],
      );
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it('rejects a SharedFrameworks symlink outside the Xcode bundle', async () => {
    const scratch = mkdtempSync(join(tmpdir(), 'maka-xcode-frameworks-escape-'));
    const contents = join(scratch, 'Xcode.app', 'Contents');
    const developer = join(contents, 'Developer');
    const library = join(developer, 'usr', 'lib');
    mkdirSync(library, { recursive: true });
    writeFileSync(join(library, 'libxcrun.dylib'), 'fixture');
    symlinkSync('/', join(contents, 'SharedFrameworks'));
    try {
      assert.deepEqual(
        await resolveMacosDeveloperExecutableRoots({
          developerDir: developer,
          validateAppleBinary: () => true,
        }),
        [],
      );
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it('rejects a toolchain library symlink outside the selected developer directory', async () => {
    const scratch = mkdtempSync(join(tmpdir(), 'maka-clt-library-escape-'));
    const developer = join(scratch, 'CommandLineTools');
    const externalLibrary = join(scratch, 'external-lib');
    mkdirSync(join(developer, 'usr'), { recursive: true });
    mkdirSync(externalLibrary);
    writeFileSync(join(externalLibrary, 'libxcrun.dylib'), 'fixture');
    symlinkSync(externalLibrary, join(developer, 'usr', 'lib'));
    try {
      assert.deepEqual(
        await resolveMacosDeveloperExecutableRoots({
          developerDir: developer,
          validateAppleBinary: () => true,
        }),
        [],
      );
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it('rejects root, home, ordinary directories, and unresolved symlinks', async () => {
    const scratch = mkdtempSync(join(tmpdir(), 'maka-invalid-developer-'));
    const ordinary = join(scratch, 'ordinary');
    const dangling = join(scratch, 'dangling');
    mkdirSync(ordinary);
    symlinkSync(join(scratch, 'missing'), dangling);
    try {
      assert.deepEqual(await resolveMacosDeveloperExecutableRoots({ developerDir: '/' }), []);
      assert.deepEqual(
        await resolveMacosDeveloperExecutableRoots({ developerDir: scratch, homeDir: scratch }),
        [],
      );
      assert.deepEqual(await resolveMacosDeveloperExecutableRoots({ developerDir: ordinary }), []);
      assert.deepEqual(await resolveMacosDeveloperExecutableRoots({ developerDir: dangling }), []);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it('uses DEVELOPER_DIR before consulting xcode-select', async () => {
    let selected = false;
    await resolveMacosDeveloperExecutableRoots({
      developerDir: '/',
      selectDeveloperDir: () => {
        selected = true;
        return undefined;
      },
    });
    assert.equal(selected, false);
  });

  it('bounds both discovery subprocesses to one second and fails closed on timeout', async () => {
    const scratch = mkdtempSync(join(tmpdir(), 'maka-bounded-toolchain-'));
    const developer = join(scratch, 'CommandLineTools');
    const library = join(developer, 'usr', 'lib');
    mkdirSync(library, { recursive: true });
    writeFileSync(join(library, 'libxcrun.dylib'), 'fixture');
    const calls: Array<{ executable: string; args: readonly string[]; timeout: number }> = [];
    const runCommand: MacosDeveloperCommandRunner = async (executable, args, options) => {
      calls.push({ executable, args, timeout: options.timeout });
      if (executable === '/usr/bin/xcode-select') {
        return { status: 0, stdout: `${developer}\n` };
      }
      return { status: null };
    };
    try {
      assert.deepEqual(await resolveMacosDeveloperExecutableRoots({ runCommand }), []);
      assert.deepEqual(calls, [
        { executable: '/usr/bin/xcode-select', args: ['-p'], timeout: 1_000 },
        {
          executable: '/usr/bin/codesign',
          args: [
            '--verify',
            '--strict',
            '-R=anchor apple',
            realpathSync(join(library, 'libxcrun.dylib')),
          ],
          timeout: 1_000,
        },
      ]);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it('fails closed when developer-directory discovery times out', async () => {
    const calls: string[] = [];
    const runCommand: MacosDeveloperCommandRunner = async (executable) => {
      calls.push(executable);
      return { status: null };
    };

    assert.deepEqual(await resolveMacosDeveloperExecutableRoots({ runCommand }), []);
    assert.deepEqual(calls, ['/usr/bin/xcode-select']);
  });

  it('returns a canonical root that is unaffected by later selector alias replacement', async () => {
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
      const roots = await resolveMacosDeveloperExecutableRoots({
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

  it('rejects a structurally plausible toolchain containing a non-Mach-O libxcrun', async () => {
    const scratch = mkdtempSync(join(tmpdir(), 'maka-unsigned-clt-'));
    const developer = join(scratch, 'CommandLineTools');
    const library = join(developer, 'usr', 'lib');
    mkdirSync(library, { recursive: true });
    writeFileSync(join(library, 'libxcrun.dylib'), 'not signed');
    try {
      assert.deepEqual(await resolveMacosDeveloperExecutableRoots({ developerDir: developer }), []);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});

describe('Apple signer validation', { skip: process.platform !== 'darwin' }, () => {
  it('rejects a valid ad-hoc-signed dylib in a plausible toolchain', async () => {
    const scratch = mkdtempSync(join(tmpdir(), 'maka-adhoc-clt-'));
    const developer = join(scratch, 'CommandLineTools');
    const library = join(developer, 'usr', 'lib');
    const binary = join(library, 'libxcrun.dylib');
    mkdirSync(library, { recursive: true });
    try {
      const source = join(scratch, 'fixture.c');
      writeFileSync(source, 'int fixture(void) { return 0; }\n');
      const compile = spawnSync('/usr/bin/clang', ['-dynamiclib', source, '-o', binary], {
        encoding: 'utf8',
      });
      assert.equal(compile.status, 0, compile.stderr);
      const sign = spawnSync('/usr/bin/codesign', ['--force', '--sign', '-', binary], {
        encoding: 'utf8',
      });
      assert.equal(sign.status, 0, sign.stderr);
      const verify = spawnSync('/usr/bin/codesign', ['--verify', '--strict', binary], {
        encoding: 'utf8',
      });
      assert.equal(verify.status, 0, verify.stderr);
      assert.deepEqual(await resolveMacosDeveloperExecutableRoots({ developerDir: developer }), []);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});

describe('resolveMacosCommandPaths', () => {
  it('does not add selected developer roots to restricted read-only profiles', async () => {
    let validated = false;
    const scratch = mkdtempSync(join(tmpdir(), 'maka-read-only-toolchain-'));
    const developer = join(scratch, 'CommandLineTools');
    const library = join(developer, 'usr', 'lib');
    mkdirSync(library, { recursive: true });
    writeFileSync(join(library, 'libxcrun.dylib'), 'fixture');
    try {
      assert.deepEqual(
        await resolveMacosCommandPaths(
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

  it('adds only validated developer roots to writable command profiles', async () => {
    const scratch = mkdtempSync(join(tmpdir(), 'maka-writable-toolchain-'));
    const developer = join(scratch, 'CommandLineTools');
    const library = join(developer, 'usr', 'lib');
    mkdirSync(library, { recursive: true });
    writeFileSync(join(library, 'libxcrun.dylib'), 'fixture');
    try {
      assert.deepEqual(
        await resolveMacosCommandPaths(
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
