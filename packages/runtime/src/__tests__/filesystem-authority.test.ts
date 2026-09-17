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

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExecutionBoundary } from '@maka/core/sandbox-boundary';
import { buildBuiltinTools } from '../builtin-tools.js';

import { createLocalWorkspaceExecutor } from '../workspace-executor.js';
import type { MakaTool } from '../tool-runtime.js';

/**
 * The execution boundary is the only authority over where the file tools may
 * reach. These tests pin that from the outside — through the tools themselves,
 * against a real filesystem — because the defect they cover (#2083) was
 * invisible to every unit that knew only one of the two backends: "full access"
 * was the one mode where an undeclared cwd containment became the arbiter, and
 * it was stricter than the profile every other mode enforces.
 */

const BYPASS: ExecutionBoundary = { kind: 'bypass', revision: 0 };

async function makeDirs(): Promise<{ cwd: string; outside: string; cleanup: () => Promise<void> }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'maka-fs-authority-')));
  const cwd = join(root, 'session');
  const outside = join(root, 'outside');
  await mkdir(cwd);
  await mkdir(outside);
  return { cwd, outside, cleanup: () => rm(root, { recursive: true, force: true }) };
}

function toolsFor(overrides: Parameters<typeof buildBuiltinTools>[0] = {}): MakaTool[] {
  return buildBuiltinTools({ executor: createLocalWorkspaceExecutor(), ...overrides });
}

function toolNamed(tools: MakaTool[], name: string): MakaTool {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`${name} tool missing`);
  return tool;
}

function runTool(
  tool: MakaTool,
  args: unknown,
  cwd: string,
  executionBoundary?: ExecutionBoundary,
): Promise<unknown> {
  return Promise.resolve(
    tool.impl(args as never, {
      sessionId: 'session-1',
      turnId: 'turn-1',
      cwd,
      toolCallId: 'tool-1',
      operationId: 'toolop-1',
      abortSignal: new AbortController().signal,
      emitOutput: () => {},
      ...(executionBoundary ? { executionBoundary } : {}),
    }),
  );
}

describe('file tools follow the execution boundary', () => {
  test('a bypass boundary reaches outside the session cwd, as Bash already does', async () => {
    const { cwd, outside, cleanup } = await makeDirs();
    try {
      const tools = toolsFor();
      const target = join(outside, 'note.md');

      const written = await runTool(
        toolNamed(tools, 'Write'),
        { path: target, content: 'hello' },
        cwd,
        BYPASS,
      );
      assert.partialDeepStrictEqual(written, { kind: 'file_diff' });
      assert.deepStrictEqual((written as { paths: string[] }).paths, [target]);
      assert.ok((written as { diff: string }).diff.includes('--- /dev/null'));
      assert.ok((written as { diff: string }).diff.includes('+hello'));
      assert.strictEqual(await readFile(target, 'utf8'), 'hello');

      const read = await runTool(toolNamed(tools, 'Read'), { path: target }, cwd, BYPASS);
      assert.partialDeepStrictEqual(read, { content: 'hello', next: null });

      const edited = await runTool(
        toolNamed(tools, 'Edit'),
        { path: target, old_string: 'hello', new_string: 'bye' },
        cwd,
        BYPASS,
      );
      assert.partialDeepStrictEqual(edited, { kind: 'file_diff' });
      assert.deepStrictEqual((edited as { paths: string[] }).paths, [target]);
      assert.ok((edited as { diff: string }).diff.includes('-hello'));
      assert.ok((edited as { diff: string }).diff.includes('+bye'));
      assert.strictEqual(await readFile(target, 'utf8'), 'bye');

      await writeFile(join(outside, 'data.json'), '{"b":1,"a":2}', 'utf8');
      const formatted = await runTool(
        toolNamed(tools, 'FormatJson'),
        { path: join(outside, 'data.json'), sort_keys: true },
        cwd,
        BYPASS,
      );
      assert.partialDeepStrictEqual(formatted, { kind: 'file_diff' });

      const globbed = (await runTool(
        toolNamed(tools, 'Glob'),
        { pattern: '*.md', cwd: outside },
        cwd,
        BYPASS,
      )) as { files: string[] };
      assert.deepStrictEqual(globbed.files, ['note.md']);
    } finally {
      await cleanup();
    }
  });

  test('host file operations follow symlinks outside the cwd', async () => {
    const { cwd, outside, cleanup } = await makeDirs();
    try {
      const tools = toolsFor();
      await writeFile(join(outside, 'secret.txt'), 'secret', 'utf8');
      await symlink(join(outside, 'secret.txt'), join(cwd, 'link.txt'));

      // Under bypass the same link resolves, because nothing is being escaped.
      assert.deepStrictEqual(
        await runTool(toolNamed(tools, 'Read'), { path: 'link.txt' }, cwd, BYPASS),
        {
          content: 'secret',
          offset: 0,
          returnedLines: 1,
          totalLines: 1,
          next: null,
        },
      );
    } finally {
      await cleanup();
    }
  });

  test('host glob patterns can address paths outside the cwd', async () => {
    const { cwd, outside, cleanup } = await makeDirs();
    try {
      const tools = toolsFor();
      await writeFile(join(outside, 'note.md'), '', 'utf8');
      const absolute = join(outside, '*.md');

      const globbed = (await runTool(
        toolNamed(tools, 'Glob'),
        { pattern: absolute },
        cwd,
        BYPASS,
      )) as { files: string[] };
      assert.strictEqual(globbed.files.length, 1);
    } finally {
      await cleanup();
    }
  });

  test('one file takes one write lock however its path is spelled', async () => {
    const { cwd, outside, cleanup } = await makeDirs();
    try {
      const target = join(outside, 'note.md');
      await writeFile(target, 'a', 'utf8');

      // Instrumented so the assertion is about serialisation itself. A plain
      // concurrent-write race proves nothing: one write(2) per file is already
      // atomic, so the survivor is whole even with no lock at all. Only an
      // overlap counter distinguishes a held lock from the kernel's own
      // serialisation, and only two spellings of one path prove the key
      // canonicalises. Ordering is enforced with causal barriers instead of
      // timers (#2132): submission order cannot promise acquisition order,
      // because the lock key derivation is itself async. The first read waits
      // for the second key to resolve. A working lock keeps that second read
      // queued; a lockless implementation necessarily overlaps it with the
      // first read, which is still active at that exact boundary.
      const host = createLocalWorkspaceExecutor();
      let active = 0;
      let overlapped = false;
      let reads = 0;
      let keys = 0;
      let firstReadStarted!: () => void;
      const firstReadStartedPromise = new Promise<void>((resolve) => {
        firstReadStarted = resolve;
      });
      let secondKeyResolved!: () => void;
      const secondKeyResolvedPromise = new Promise<void>((resolve) => {
        secondKeyResolved = resolve;
      });
      const pinnedReadModifyWrite = host.readModifyWrite;
      if (!pinnedReadModifyWrite) {
        throw new Error('LocalWorkspaceExecutor must provide readModifyWrite');
      }
      const tools = toolsFor({
        executor: Object.assign(Object.create(host) as typeof host, {
          writeLockKey: async (input: Parameters<typeof host.writeLockKey>[0]) => {
            const result = await host.writeLockKey(input);
            keys += 1;
            if (keys === 2) secondKeyResolved();
            return result;
          },
          readFile: async (input: Parameters<typeof host.readFile>[0]) => {
            active += 1;
            overlapped ||= active > 1;
            reads += 1;
            if (reads === 1) {
              firstReadStarted();
              await secondKeyResolvedPromise;
            }
            try {
              return await host.readFile(input);
            } finally {
              active -= 1;
            }
          },
          readModifyWrite: async (input: Parameters<typeof pinnedReadModifyWrite>[0]) => {
            // The pinned read-modify-write is the mutation's read step now
            // (#2600); the causal barrier lives here for the same reason it
            // lived on readFile before.
            active += 1;
            overlapped ||= active > 1;
            reads += 1;
            if (reads === 1) {
              firstReadStarted();
              await secondKeyResolvedPromise;
            }
            try {
              return await pinnedReadModifyWrite(input);
            } finally {
              active -= 1;
            }
          },
        }),
      });
      const edit = toolNamed(tools, 'Edit');

      const first = runTool(edit, { path: target, old_string: 'a', new_string: 'b' }, cwd, BYPASS);
      await firstReadStartedPromise;
      const second = runTool(
        edit,
        { path: join('..', 'outside', 'note.md'), old_string: 'b', new_string: 'c' },
        cwd,
        BYPASS,
      );
      await Promise.all([first, second]);

      assert.strictEqual(overlapped, false);
      // The second edit saw the first one's output, so they ran in sequence
      // against one file rather than racing two reads of the same start state.
      assert.strictEqual(await readFile(target, 'utf8'), 'c');
    } finally {
      await cleanup();
    }
  });

  test('the lock key is the same for every spelling of one file', async () => {
    const { cwd, outside, cleanup } = await makeDirs();
    try {
      const executor = createLocalWorkspaceExecutor();
      const target = join(outside, 'note.md');

      const absolute = await executor.writeLockKey({ cwd, path: target });
      const relative = await executor.writeLockKey({
        cwd,
        path: join('..', 'outside', 'note.md'),
      });
      assert.strictEqual(absolute.key, relative.key);
    } finally {
      await cleanup();
    }
  });

  test('a bypass boundary searches outside the session cwd', async () => {
    const { cwd, outside, cleanup } = await makeDirs();
    try {
      const tools = toolsFor();
      await writeFile(join(outside, 'note.md'), 'needle here\n', 'utf8');

      const found = (await runTool(
        toolNamed(tools, 'Grep'),
        { pattern: 'needle', path: outside },
        cwd,
        BYPASS,
      )) as { matches: string[] };
      assert.strictEqual(found.matches.length, 1);
      assert.ok(found.matches[0].includes('needle here'));
    } finally {
      await cleanup();
    }
  });
});
