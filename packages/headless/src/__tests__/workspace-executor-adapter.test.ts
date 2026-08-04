import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  EXTERNAL_ISOLATED_WORKSPACE_EXECUTOR_FACTS,
  isolatedToolExecutorToWorkspaceExecutor,
} from '../workspace-executor-adapter.js';
import type { IsolatedToolExecutor } from '../isolation.js';
import type { WorkspaceExecutor, WorkspaceWriteExecutor } from '@maka/runtime/workspace-executor';

describe('isolatedToolExecutorToWorkspaceExecutor', () => {
  test('defaults to conservative local-impact facts unless isolation is explicitly asserted', async () => {
    const isolated: IsolatedToolExecutor = {
      async exec() {
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    };
    const executor = isolatedToolExecutorToWorkspaceExecutor(isolated);

    assert.deepEqual(executor.facts, {
      isolation: 'none',
      writesAffectHost: true,
      writeBack: 'direct',
      network: 'host',
      secrets: 'host_env',
    });
  });

  test('accepts explicit external sandbox facts', async () => {
    const isolated: IsolatedToolExecutor = {
      async exec() {
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    };
    const executor = isolatedToolExecutorToWorkspaceExecutor(
      isolated,
      EXTERNAL_ISOLATED_WORKSPACE_EXECUTOR_FACTS,
    );

    assert.deepEqual(executor.facts, {
      isolation: 'remote',
      writesAffectHost: false,
      writeBack: 'diff_review',
      network: 'sandbox',
      secrets: 'brokered',
    });
  });

  test('fails closed for shell and search operations that cannot preserve runtime controls', async () => {
    const calls: unknown[] = [];
    const isolated: IsolatedToolExecutor = {
      async exec(input) {
        calls.push(input);
        return { exitCode: 0, stdout: 'out', stderr: 'err' };
      },
      async globFiles(input) {
        calls.push({ kind: 'glob', input });
        return { files: ['src/main.ts'] };
      },
      async grepFiles(input) {
        calls.push({ kind: 'grep', input });
        return { matches: ['src/main.ts:1:token'] };
      },
    };
    const executor = isolatedToolExecutorToWorkspaceExecutor(isolated);
    const unsafeExecutor = executor as unknown as Pick<
      WorkspaceExecutor,
      'exec' | 'globFiles' | 'grepFiles'
    >;

    await assert.rejects(
      () =>
        unsafeExecutor.exec({
          command: 'npm test',
          cwd: '/workspace',
          timeoutMs: 12_000,
        }),
      /does not adapt Bash/,
    );
    await assert.rejects(
      () =>
        unsafeExecutor.globFiles({
          cwd: '/workspace',
          pattern: '**/*.ts',
          limit: 200,
        }),
      /does not adapt Glob/,
    );
    await assert.rejects(
      () =>
        unsafeExecutor.grepFiles({
          cwd: '/workspace',
          pattern: 'token',
          path: 'src',
          maxCountPerFile: 50,
          limit: 200,
          timeoutMs: 12_000,
        }),
      /does not adapt Grep/,
    );
    assert.deepEqual(calls, []);
  });

  test('delegates native write operations when the isolated executor provides them', async () => {
    const calls: unknown[] = [];
    const isolated: IsolatedToolExecutor = {
      async exec() {
        return { exitCode: 0, stdout: '', stderr: '' };
      },
      async writeFile(input) {
        calls.push({ kind: 'write', input });
        return { ok: true, path: input.path, bytes: 5 };
      },
    };
    const executor = isolatedToolExecutorToWorkspaceExecutor(isolated);

    assert.deepEqual(
      await executor.writeFile({ cwd: '/workspace', path: 'out.txt', content: 'hello' }),
      {
        ok: true,
        path: 'out.txt',
        bytes: 5,
      },
    );
    assert.deepEqual(calls, [
      { kind: 'write', input: { cwd: '/workspace', path: 'out.txt', content: 'hello' } },
    ]);
  });

  test('fails closed when writeFile is used without native isolated write support', async () => {
    const isolated: IsolatedToolExecutor = {
      async exec() {
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    };
    const executor = isolatedToolExecutorToWorkspaceExecutor(isolated);

    await assert.rejects(
      () => executor.writeFile({ cwd: '/workspace', path: 'out.txt', content: 'hello' }),
      /requires native writeFile/,
    );
  });

  test('refuses host path scope instead of degrading the isolated workspace', async () => {
    const isolated: IsolatedToolExecutor = {
      async exec() {
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    };
    const executor = isolatedToolExecutorToWorkspaceExecutor(isolated);

    for (const resolve of [executor.resolveWritablePath, executor.resolveExistingPath]) {
      await assert.rejects(
        () =>
          resolve({
            cwd: '/workspace',
            path: '/tmp/out.txt',
            label: 'Write',
            scope: 'host',
          }),
        /cannot use host path scope/,
      );
    }
    assert.deepEqual(
      await executor.resolveWritablePath({
        cwd: '/workspace',
        path: 'out.txt',
        label: 'Write',
        scope: 'workspace',
      }),
      { path: '/workspace/out.txt' },
    );
  });

  test('exposes only supported workspace capabilities at the type boundary', () => {
    const isolated: IsolatedToolExecutor = {
      async exec() {
        return { exitCode: 0, stdout: '', stderr: '' };
      },
      async writeFile(input) {
        return { ok: true, path: input.path, bytes: 0 };
      },
    };
    const executor = isolatedToolExecutorToWorkspaceExecutor(isolated);

    acceptsWorkspaceWriteExecutor(executor);
    // @ts-expect-error The adapter must not type-check as a full WorkspaceExecutor.
    acceptsWorkspaceExecutor(executor);
  });
});

function acceptsWorkspaceWriteExecutor(_executor: WorkspaceWriteExecutor): void {}

function acceptsWorkspaceExecutor(_executor: WorkspaceExecutor): void {}
