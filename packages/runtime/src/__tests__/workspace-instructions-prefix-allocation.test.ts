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
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';
import {
  MAX_WORKSPACE_INSTRUCTION_FILE_CHARS as cap,
  buildWorkspaceInstructionsPromptFragment as build,
} from '../system-prompt/workspace-instructions.js';

it('preserves instruction prefixes and full-content deduplication with bounded iteration', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-workspace-prefix-'));
  const homeDir = join(root, 'home');
  const globalDir = join(homeDir, '.maka');
  const project = join(root, 'project');
  await mkdir(globalDir, { recursive: true });
  await mkdir(project);
  const reads: number[] = [];
  try {
    await writeFile(join(project, 'AGENTS.md'), 'REFERENCE');
    const reference = await build(project, { homeDir });
    assert.ok(reference);
    const fixtures = [
      'A'.repeat(cap - 1),
      'B'.repeat(cap),
      'C'.repeat(cap + 1),
      '😀'.repeat(cap),
      '😀'.repeat(cap + 1),
      'D'.repeat(cap - 1) + '😀' + 'TAIL',
      '汉😀e\u0301\ud800"\\\n'.repeat(24000),
      'X'.repeat(262144),
      '  \u0000' + 'Y'.repeat(cap + 1) + '\u0007  ',
    ];
    for (const raw of fixtures) {
      await writeFile(join(project, 'AGENTS.md'), raw);
      // Disk UTF-8 encoding replaces lone surrogates before the public reader.
      const cleaned = Buffer.from(raw)
        .toString('utf8')
        .trim()
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
      const points = Array.from(cleaned);
      const clipped = points.slice(0, cap).join('');
      const expected: string = reference.replace(
        'REFERENCE',
        clipped + (points.length > cap ? '\n[instructions truncated]' : ''),
      );
      const original = String.prototype[Symbol.iterator];
      String.prototype[Symbol.iterator] = function (): StringIterator<string> {
        const iterator = original.call(this);
        if (String(this) !== cleaned || points.length <= cap) return iterator;
        const index = reads.push(0) - 1;
        return {
          next() {
            const next = iterator.next();
            if (!next.done) reads[index] = (reads[index] ?? 0) + 1;
            return next;
          },
          [Symbol.iterator]() {
            return this;
          },
          [Symbol.dispose]() {},
        };
      };
      let actual: string | undefined;
      try {
        actual = await build(project, { homeDir });
      } finally {
        String.prototype[Symbol.iterator] = original;
      }
      assert.equal(actual, expected);
    }

    // Same clipped prefix but distinct full-file digests must remain two blocks.
    const prefix = 'P'.repeat(cap);
    await writeFile(join(project, 'AGENTS.md'), prefix + 'first');
    await writeFile(join(project, 'CLAUDE.md'), prefix + 'second');
    await writeFile(join(project, 'GEMINI.md'), prefix + 'first');
    const different = await build(project, { homeDir });
    assert.ok(different);
    assert.equal(different.split('<workspace-instructions ').length - 1, 2);
    assert.ok(different.includes('file="CLAUDE.md"'));
    assert.ok(!different.includes('file="GEMINI.md"'));
    assert.equal(different.split('[instructions truncated]').length - 1, 2);

    // Cross-scope duplicates stay distinct, and global files consume budget first.
    await writeFile(join(globalDir, 'AGENTS.md'), prefix + 'first');
    const layered = await build(project, { homeDir });
    assert.ok(layered);
    assert.equal(layered.split('<workspace-instructions ').length - 1, 3);
    assert.ok(layered.indexOf('scope="global"') < layered.indexOf('scope="project"'));
    assert.ok(layered.length <= 14064);

    // Check allocation only after all externally visible semantics have passed.
    assert.ok(reads.length >= 5);
    assert.ok(
      reads.every((count) => count <= cap + 1),
      JSON.stringify(reads),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
