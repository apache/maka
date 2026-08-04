import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExecutionBoundary } from '@maka/core';
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
      expect(written).toMatchObject({ ok: true, path: target });
      expect(await readFile(target, 'utf8')).toBe('hello');

      const read = await runTool(toolNamed(tools, 'Read'), { path: target }, cwd, BYPASS);
      expect(read).toEqual({ content: 'hello' });

      const edited = await runTool(
        toolNamed(tools, 'Edit'),
        { path: target, old_string: 'hello', new_string: 'bye' },
        cwd,
        BYPASS,
      );
      expect(edited).toMatchObject({ ok: true, replacements: 1 });
      expect(await readFile(target, 'utf8')).toBe('bye');

      await writeFile(join(outside, 'data.json'), '{"b":1,"a":2}', 'utf8');
      const formatted = await runTool(
        toolNamed(tools, 'FormatJson'),
        { path: join(outside, 'data.json'), sort_keys: true },
        cwd,
        BYPASS,
      );
      expect(formatted).toMatchObject({ ok: true, valid: true, changed: true });

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
      expect(result).toMatchObject({ ok: true, path: target });
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
      const tools = toolsFor();
      const target = join(outside, 'note.md');
      const order: string[] = [];
      const write = toolNamed(tools, 'Write');

      await Promise.all([
        runTool(write, { path: target, content: 'a'.repeat(4096) }, cwd, BYPASS).then(() =>
          order.push('absolute'),
        ),
        runTool(write, { path: join('..', 'outside', 'note.md'), content: 'b' }, cwd, BYPASS).then(
          () => order.push('relative'),
        ),
      ]);

      // Both spellings resolve to one file, so the lock serialised them and the
      // survivor is whole rather than interleaved.
      expect(['a'.repeat(4096), 'b']).toContain(await readFile(target, 'utf8'));
      expect(order).toHaveLength(2);
    } finally {
      await cleanup();
    }
  });
});
