#!/usr/bin/env node
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

import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const defaultRepoRoot = resolve(scriptDirectory, '..');
const defaultBiomePath = join(
  defaultRepoRoot,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'biome.cmd' : 'biome',
);

const maxBlobBytes = 16 * 1024 * 1024;

const decodes = (buffer) => {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    return true;
  } catch {
    return false;
  }
};

// git's own text/binary rule, asked for once and only when something is too
// large to read: it decides which oversized blob is an asset and which is a
// file the formatter would have owned.
function binaryStagedPaths(root) {
  const records = execFileSync(
    'git',
    ['diff', '--cached', '--numstat', '--diff-filter=ACMR', '-z'],
    { cwd: root },
  )
    .toString('utf8')
    .split('\0');
  const binary = new Set();
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record) continue;
    const [added, deleted, ...rest] = record.split('\t');
    // A rename writes its counts alone, then the old and the new path.
    let path = rest.join('\t');
    if (path === '') {
      index += 2;
      path = records[index];
    }
    if (added === '-' && deleted === '-') binary.add(path);
  }
  return binary;
}

export function checkStagedWithBiome({
  root = defaultRepoRoot,
  biomePath = defaultBiomePath,
  maxBytes = maxBlobBytes,
} = {}) {
  const output = execFileSync(
    'git',
    ['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z'],
    { cwd: root },
  );
  const paths = output.toString('utf8').split('\0').filter(Boolean);

  let binary;
  for (const path of paths) {
    // Every staged blob passes through here, images included, so ask for the
    // size before reading it: Node's default 1 MiB buffer used to kill the
    // commit for anything larger. An asset over the ceiling is left alone, but
    // a text file over it is one the formatter owns and this cannot read, so
    // it stops the commit rather than passing silently.
    const size = Number(
      execFileSync('git', ['cat-file', '-s', `:${path}`], { cwd: root })
        .toString('utf8')
        .trim(),
    );
    if (size > maxBytes) {
      binary ??= binaryStagedPaths(root);
      if (binary.has(path)) continue;
      process.stderr.write(
        `${path}: staged text is ${size} bytes, over the ${maxBytes} this check reads\n`,
      );
      return false;
    }
    const contents = execFileSync('git', ['show', `:${path}`], {
      cwd: root,
      maxBuffer: maxBytes,
    });
    // Biome reads stdin as UTF-8 and errors on anything else, so skip a blob
    // it cannot decode. Deciding on that rather than on a NUL byte keeps a
    // source file that legitimately contains one inside the check.
    if (!decodes(contents)) continue;
    const result = spawnSync(
      biomePath,
      [
        'check',
        '--write',
        `--stdin-file-path=${path}`,
        '--files-ignore-unknown=true',
        '--no-errors-on-unmatched',
      ],
      // Biome echoes the file back, with room for a rewrite that grows it.
      { cwd: root, input: contents, maxBuffer: 2 * maxBytes },
    );
    if (result.error) throw result.error;
    if (result.status !== 0) {
      if (result.stdout.length > 0) process.stdout.write(result.stdout);
      if (result.stderr.length > 0) process.stderr.write(result.stderr);
      return false;
    }
    // Biome echoes the input for files it formats or ignores, but prints
    // nothing for a language it parses without formatting, such as Markdown.
    if (result.stdout.length === 0) continue;
    if (!result.stdout.equals(contents)) {
      process.stderr.write(`${path}: staged content is not formatted by Biome\n`);
      return false;
    }
  }

  return true;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!checkStagedWithBiome()) process.exitCode = 1;
}
