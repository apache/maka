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

import { execFileSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { licenseFiles } from './license-files.mjs';

/** Collect from the same checkout and GN graph that produced the static library. */
export async function v8Notices(checkout, generated, source, env) {
  const run = (command, args) =>
    execFileSync(command, args, {
      cwd: checkout,
      env,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    });
  if (run('git', ['rev-parse', 'HEAD']).trim() !== source.revision)
    throw new Error('V8 checkout identity changed');
  const args = await readFile(join(generated, 'args.gn'), 'utf8');
  if (!/^v8_use_libm_trig_functions = false$/m.test(args))
    throw new Error('V8 release must exclude vendored glibc math');
  const graph = JSON.parse(
    run(env.GN, [
      '--script-executable=' + env.PYTHON,
      'desc',
      generated,
      '//:rusty_v8',
      'deps',
      '--all',
      '--format=json',
    ]),
  );
  const dependencies = graph['//:rusty_v8'].deps;
  if (dependencies.some((value) => value.split('(')[0] === '//v8:libm'))
    throw new Error('V8 graph includes vendored glibc');
  const selected = new Set([join(checkout, 'LICENSE')]);
  for (const name of await readdir(join(checkout, 'v8'))) {
    if (name.startsWith('LICENSE')) selected.add(join(checkout, 'v8', name));
  }
  // Header-only components can be included directly by V8 source files.
  for (const entry of await readdir(join(checkout, 'v8/third_party'), { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name !== 'glibc') {
      for (const path of await licenseFiles(join(checkout, 'v8/third_party', entry.name)))
        selected.add(path);
    }
  }
  const directories = new Set([
    'third_party/libc++',
    'third_party/libc++abi',
    'third_party/libunwind',
  ]);
  for (const dependency of dependencies) {
    const path = dependency.split(':')[0].slice(2);
    if (path.startsWith('third_party/rust/')) {
      const build = await readFile(join(checkout, path, 'BUILD.gn'), 'utf8').catch(() => '');
      for (const match of build.matchAll(
        /\/\/third_party\/rust\/chromium_crates_io\/vendor\/([^/"\s]+)/g,
      )) {
        directories.add('third_party/rust/chromium_crates_io/vendor/' + match[1]);
      }
    } else if (path.startsWith('third_party/'))
      directories.add(path.split('/').slice(0, 2).join('/'));
  }
  for (const directory of directories) {
    for (const path of await licenseFiles(join(checkout, directory))) selected.add(path);
  }
  // GN builds its own standard library with Chromium's pinned Rust toolchain.
  for (const path of await licenseFiles(
    join(checkout, 'third_party/rust-toolchain/lib/rustlib/src/rust/library'),
  ))
    selected.add(path);
  const sections = [];
  for (const path of [...selected].sort()) {
    const content = await readFile(path, 'utf8');
    if (!content.trim() || content.includes('\0')) throw new Error('Invalid V8 notice: ' + path);
    sections.push(relative(checkout, path).replaceAll('\\', '/') + '\n\n' + content);
  }
  return (
    'V8 source build\nSource: ' +
    source.repository +
    '\nRevision: ' +
    source.revision +
    '\nGN arguments:\n' +
    args +
    '\nSubmodule revisions:\n' +
    run('git', ['submodule', 'status', '--recursive']) +
    '\n' +
    sections.join('\n' + '='.repeat(80) + '\n')
  );
}
