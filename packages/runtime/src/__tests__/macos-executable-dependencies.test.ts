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
import { dirname } from 'node:path';
import { describe, test } from 'node:test';

import {
  resolveMacosExecutableDependencies,
  type MacosOtoolRequest,
} from '../filesystem-worker/macos-executable-dependencies.js';

describe('macOS executable dependency resolution', () => {
  test('adds lexical and canonical directories for recursive absolute dependencies', async () => {
    const executable = '/opt/homebrew/Cellar/ripgrep/15.1.0/bin/rg';
    const lexicalPcre = '/opt/homebrew/opt/pcre2/lib/libpcre2-8.0.dylib';
    const canonicalPcre = '/opt/homebrew/Cellar/pcre2/10.45/lib/libpcre2-8.0.dylib';
    const fixture = dependencyFixture({
      files: new Map([
        [executable, executable],
        [lexicalPcre, canonicalPcre],
        [canonicalPcre, canonicalPcre],
      ]),
      loadCommands: new Map([
        [
          executable,
          machoLoadCommands({
            dependencies: [lexicalPcre, '/usr/lib/libiconv.2.dylib', '/usr/lib/libSystem.B.dylib'],
          }),
        ],
        [
          canonicalPcre,
          machoLoadCommands({
            id: lexicalPcre,
            dependencies: ['/usr/lib/libSystem.B.dylib'],
          }),
        ],
      ]),
    });

    const result = await resolveMacosExecutableDependencies(executable, fixture);

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.dependencyCount, 1);
    assert.deepEqual(result.runtimeReadableRoots, [
      '/opt/homebrew/opt/pcre2/lib',
      '/opt/homebrew/Cellar/pcre2/10.45/lib',
    ]);
    assert.deepEqual(result.executableRoots, [
      dirname(executable),
      '/opt/homebrew/opt/pcre2/lib',
      '/opt/homebrew/Cellar/pcre2/10.45/lib',
    ]);
  });

  test('resolves rpath, loader_path, and executable_path dependencies recursively', async () => {
    const executable = '/Applications/Maka.app/Contents/Resources/bin/rg';
    const library = '/Applications/Maka.app/Contents/Resources/lib/libsearch.dylib';
    const loaderLibrary = '/Applications/Maka.app/Contents/Resources/lib/libloader.dylib';
    const executableLibrary = '/Applications/Maka.app/Contents/Resources/bin/libexec.dylib';
    const fixture = dependencyFixture({
      files: new Map([
        [executable, executable],
        [library, library],
        [loaderLibrary, loaderLibrary],
        [executableLibrary, executableLibrary],
      ]),
      loadCommands: new Map([
        [
          executable,
          machoLoadCommands({
            dependencies: ['@rpath/libsearch.dylib'],
            runpaths: ['@executable_path/../lib'],
          }),
        ],
        [
          library,
          machoLoadCommands({
            id: '@rpath/libsearch.dylib',
            dependencies: ['@loader_path/libloader.dylib', '@executable_path/libexec.dylib'],
          }),
        ],
        [loaderLibrary, machoLoadCommands({ dependencies: ['/usr/lib/libSystem.B.dylib'] })],
        [executableLibrary, machoLoadCommands()],
      ]),
    });

    const result = await resolveMacosExecutableDependencies(executable, fixture);

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.dependencyCount, 3);
    assert.deepEqual(result.runtimeReadableRoots, [
      '/Applications/Maka.app/Contents/Resources/lib',
      '/Applications/Maka.app/Contents/Resources/bin',
    ]);
  });

  test('ignores an unresolved rpath install ID on an absolute dependency', async () => {
    const executable = '/apps/bin/rg';
    const library = '/apps/lib/libfoo.dylib';
    const fixture = dependencyFixture({
      files: new Map([
        [executable, executable],
        [library, library],
      ]),
      loadCommands: new Map([
        [executable, machoLoadCommands({ dependencies: [library] })],
        [
          library,
          machoLoadCommands({
            id: '@rpath/libfoo.dylib',
            dependencies: ['/usr/lib/libSystem.B.dylib'],
          }),
        ],
      ]),
    });

    const result = await resolveMacosExecutableDependencies(executable, fixture);

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.dependencyCount, 1);
    assert.deepEqual(result.runtimeReadableRoots, ['/apps/lib']);
  });

  test('fails closed when an rpath dependency cannot be resolved', async () => {
    const executable = '/apps/bin/rg';
    const fixture = dependencyFixture({
      files: new Map([[executable, executable]]),
      loadCommands: new Map([
        [
          executable,
          machoLoadCommands({
            dependencies: ['@rpath/libmissing.dylib'],
            runpaths: ['/apps/lib'],
          }),
        ],
      ]),
    });

    const result = await resolveMacosExecutableDependencies(executable, fixture);

    assert.deepEqual(result, {
      ok: false,
      reason: 'dependency_unresolved',
      message: 'A Mach-O dependency could not be resolved to an existing file.',
    });
  });

  test('bounds recursive dependency graphs', async () => {
    const executable = '/apps/bin/rg';
    const first = '/apps/lib/libfirst.dylib';
    const second = '/apps/lib/libsecond.dylib';
    const fixture = dependencyFixture({
      files: new Map([
        [executable, executable],
        [first, first],
        [second, second],
      ]),
      loadCommands: new Map([
        [executable, machoLoadCommands({ dependencies: [first] })],
        [first, machoLoadCommands({ dependencies: [second] })],
        [second, machoLoadCommands()],
      ]),
      maxDepth: 1,
    });

    const result = await resolveMacosExecutableDependencies(executable, fixture);

    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'dependency_limit_exceeded');
  });
});

function dependencyFixture(input: {
  files: ReadonlyMap<string, string>;
  loadCommands: ReadonlyMap<string, string>;
  maxDepth?: number;
}) {
  return {
    resolveFile: async (path: string) => input.files.get(path),
    runOtool: async (request: MacosOtoolRequest) => {
      const output = input.loadCommands.get(request.imagePath);
      if (output === undefined) throw new Error(`Missing otool fixture: ${request.imagePath}`);
      return output;
    },
    ...(input.maxDepth !== undefined ? { maxDepth: input.maxDepth } : {}),
  };
}

function machoLoadCommands(
  input: { id?: string; dependencies?: readonly string[]; runpaths?: readonly string[] } = {},
): string {
  const commands = [
    ...(input.id ? [machoDylibCommand('LC_ID_DYLIB', input.id)] : []),
    ...(input.dependencies ?? []).map((dependency) =>
      machoDylibCommand('LC_LOAD_DYLIB', dependency),
    ),
    ...(input.runpaths ?? []).map(
      (runpath) => `          cmd LC_RPATH
      cmdsize 48
         path ${runpath} (offset 12)`,
    ),
  ];
  return commands.map((command, index) => `Load command ${index}\n${command}`).join('\n');
}

function machoDylibCommand(command: string, name: string): string {
  return `          cmd ${command}
      cmdsize 56
         name ${name} (offset 24)`;
}
