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
import { Buffer } from 'node:buffer';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExecutionBoundary } from '@maka/core/sandbox-boundary';
import { createWorkspaceWritePermissionProfile } from '@maka/core/permission-profile';
import { expect } from '../test-helpers.js';
import { buildBuiltinTools } from '../builtin-tools.js';
import { SandboxCommandError } from '../sandbox/errors.js';
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
const EXTERNAL: ExecutionBoundary = { kind: 'external', revision: 0 };
const MANAGED: ExecutionBoundary = {
  kind: 'managed',
  revision: 0,
  profile: createWorkspaceWritePermissionProfile(),
};

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
      expect(written).toMatchObject({ kind: 'file_diff', paths: [target] });
      expect((written as { diff: string }).diff).toContain('--- /dev/null');
      expect((written as { diff: string }).diff).toContain('+hello');
      expect(await readFile(target, 'utf8')).toBe('hello');

      const read = await runTool(toolNamed(tools, 'Read'), { path: target }, cwd, BYPASS);
      expect(read).toEqual({ content: 'hello' });

      const edited = await runTool(
        toolNamed(tools, 'Edit'),
        { path: target, old_string: 'hello', new_string: 'bye' },
        cwd,
        BYPASS,
      );
      expect(edited).toMatchObject({ kind: 'file_diff', paths: [target] });
      expect((edited as { diff: string }).diff).toContain('-hello');
      expect((edited as { diff: string }).diff).toContain('+bye');
      expect(await readFile(target, 'utf8')).toBe('bye');

      await writeFile(join(outside, 'data.json'), '{"b":1,"a":2}', 'utf8');
      const formatted = await runTool(
        toolNamed(tools, 'FormatJson'),
        { path: join(outside, 'data.json'), sort_keys: true },
        cwd,
        BYPASS,
      );
      expect(formatted).toMatchObject({ kind: 'file_diff' });

      const globbed = (await runTool(
        toolNamed(tools, 'Glob'),
        { pattern: '*.md', cwd: outside },
        cwd,
        BYPASS,
      )) as { files: string[] };
      expect(globbed.files).toEqual(['note.md']);
    } finally {
      await cleanup();
    }
  });

  test('every other boundary keeps the same paths inside the session cwd', async () => {
    const { cwd, outside, cleanup } = await makeDirs();
    try {
      const tools = toolsFor();
      const target = join(outside, 'note.md');
      await writeFile(target, 'hello', 'utf8');

      for (const boundary of [undefined, EXTERNAL]) {
        await assert.rejects(
          runTool(toolNamed(tools, 'Write'), { path: target, content: 'x' }, cwd, boundary),
          /Write path must stay inside session cwd/,
        );
        await assert.rejects(
          runTool(toolNamed(tools, 'Read'), { path: target }, cwd, boundary),
          /Read path must stay inside session cwd/,
        );
        await assert.rejects(
          runTool(
            toolNamed(tools, 'Edit'),
            { path: target, old_string: 'hello', new_string: 'bye' },
            cwd,
            boundary,
          ),
          /Edit path must stay inside session cwd/,
        );
        await assert.rejects(
          runTool(toolNamed(tools, 'Grep'), { pattern: 'hello', path: outside }, cwd, boundary),
          /Grep path must stay inside session cwd/,
        );
      }
      // The write never landed under any of them.
      expect(await readFile(target, 'utf8')).toBe('hello');
    } finally {
      await cleanup();
    }
  });

  test('a symlink out of the cwd stays an escape under a workspace boundary', async () => {
    const { cwd, outside, cleanup } = await makeDirs();
    try {
      const tools = toolsFor();
      await writeFile(join(outside, 'secret.txt'), 'secret', 'utf8');
      await symlink(join(outside, 'secret.txt'), join(cwd, 'link.txt'));

      await assert.rejects(
        runTool(toolNamed(tools, 'Read'), { path: 'link.txt' }, cwd),
        /Read path must stay inside session cwd/,
      );
      // Under bypass the same link resolves, because nothing is being escaped.
      expect(await runTool(toolNamed(tools, 'Read'), { path: 'link.txt' }, cwd, BYPASS)).toEqual({
        content: 'secret',
      });
    } finally {
      await cleanup();
    }
  });

  test('a glob pattern may only leave the search root under a bypass boundary', async () => {
    const { cwd, outside, cleanup } = await makeDirs();
    try {
      const tools = toolsFor();
      await writeFile(join(outside, 'note.md'), '', 'utf8');
      const absolute = join(outside, '*.md');

      await assert.rejects(
        runTool(toolNamed(tools, 'Glob'), { pattern: absolute }, cwd),
        /Glob pattern must stay inside session cwd/,
      );
      const globbed = (await runTool(
        toolNamed(tools, 'Glob'),
        { pattern: absolute },
        cwd,
        BYPASS,
      )) as { files: string[] };
      expect(globbed.files).toHaveLength(1);
    } finally {
      await cleanup();
    }
  });

  test('a managed boundary goes to the worker and never to the host backend', async () => {
    const { cwd, outside, cleanup } = await makeDirs();
    try {
      const calls: unknown[] = [];
      const target = join(outside, 'note.md');
      const tools = toolsFor({
        filesystemWorker: {
          execute: async (input) => {
            calls.push(input);
            return { kind: 'write', ok: true, path: target, bytes: 1 };
          },
        },
      });

      const result = await runTool(
        toolNamed(tools, 'Write'),
        { path: target, content: 'x' },
        cwd,
        MANAGED,
      );
      expect(result).toMatchObject({ kind: 'file_write', path: target, bytes: 1 });
      expect(calls).toHaveLength(1);
      // The worker decided; nothing was written by the host backend.
      await assert.rejects(readFile(target, 'utf8'));
    } finally {
      await cleanup();
    }
  });

  test('a managed boundary without a worker refuses instead of falling back to the host', async () => {
    const { cwd, cleanup } = await makeDirs();
    try {
      const tools = toolsFor();
      await assert.rejects(
        runTool(toolNamed(tools, 'Write'), { path: 'note.md', content: 'x' }, cwd, MANAGED),
        (error: unknown) =>
          error instanceof SandboxCommandError && error.reason === 'requires_bypass',
      );
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

      expect(overlapped).toBe(false);
      // The second edit saw the first one's output, so they ran in sequence
      // against one file rather than racing two reads of the same start state.
      expect(await readFile(target, 'utf8')).toBe('c');
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
      expect(absolute.key).toBe(relative.key);
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
      expect(found.matches).toHaveLength(1);
      expect(found.matches[0]).toContain('needle here');
    } finally {
      await cleanup();
    }
  });

  test('a bypass boundary bypasses a wired worker too', async () => {
    const { cwd, outside, cleanup } = await makeDirs();
    try {
      const calls: unknown[] = [];
      const tools = toolsFor({
        filesystemWorker: {
          execute: async (input) => {
            calls.push(input);
            return { kind: 'write', ok: true, path: 'unused', bytes: 0 };
          },
        },
      });
      const target = join(outside, 'note.md');

      await runTool(toolNamed(tools, 'Write'), { path: target, content: 'host' }, cwd, BYPASS);

      expect(calls).toHaveLength(0);
      expect(await readFile(target, 'utf8')).toBe('host');
    } finally {
      await cleanup();
    }
  });

  test('worker image bytes reach the tool decoded', async () => {
    const { cwd, cleanup } = await makeDirs();
    try {
      const snapshots: Uint8Array[] = [];
      const tools = toolsFor({
        filesystemWorker: {
          execute: async () => ({
            kind: 'read_image',
            base64: Buffer.from([137, 80, 78, 71]).toString('base64'),
            mimeType: 'image/png',
          }),
        },
        snapshotImage: async (input) => {
          snapshots.push(input.bytes);
          return { kind: 'session_file', sessionId: input.sessionId, relativePath: 'artifact-1' };
        },
      });

      const result = await runTool(toolNamed(tools, 'Read'), { path: 'image.png' }, cwd, MANAGED);

      expect(result).toMatchObject({ kind: 'image', mimeType: 'image/png' });
      expect(snapshots).toHaveLength(1);
      expect(Buffer.from(snapshots[0] ?? new Uint8Array()).toString('hex')).toBe('89504e47');
    } finally {
      await cleanup();
    }
  });
});
