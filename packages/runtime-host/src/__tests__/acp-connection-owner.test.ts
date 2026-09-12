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
import { test } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { methods } from '@agentclientprotocol/sdk';
import {
  RetainedProcessTreeDescendants,
  terminateProcessTree,
} from '@maka/runtime/process-tree-terminator';
import {
  AcpConnectionError,
  AcpSetupCleanupError,
  createAcpConnection,
  withAcpConnection,
  type AcpConnectionOwner,
} from '../server/acp/connection.js';

async function fixture(
  scenario: string,
  run: (input: Parameters<typeof createAcpConnection>[0], root: string) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), 'maka-acp-owner-'));
  const executable = join(root, 'agent.mjs');
  const sdk = import.meta.resolve('@agentclientprotocol/sdk');
  const source = `#!${process.execPath}
import {agent,methods,ndJsonStream} from ${JSON.stringify(sdk)};
import {Readable,Writable} from 'node:stream';
import {writeFileSync,closeSync} from 'node:fs';
import {spawn} from 'node:child_process';
const scenario=${JSON.stringify(scenario)};
writeFileSync(${JSON.stringify(join(root, 'pid'))},String(process.pid));
setInterval(()=>{},1000);
if(scenario==='helper'||scenario==='escaped-helper'){
 process.on('SIGTERM',()=>{});
 const helper=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});process.stdout.write('ready');setInterval(()=>{},1000)"],{stdio:['ignore','pipe','ignore'],detached:scenario==='escaped-helper'});
 writeFileSync(${JSON.stringify(join(root, 'helper-pid'))},String(helper.pid));
 await new Promise(resolve=>helper.stdout.once('data',resolve));
 helper.stdout.destroy();
}
process.stderr.write('ready\\n');
if(scenario==='unsupported-batch') process.stdout.write('[]\\n');
agent({name:'fixture'}).onRequest(methods.agent.initialize,()=>{
 if(scenario==='crash') process.exit(23);
 if(scenario==='eof'){closeSync(1);return new Promise(()=>{});}
 return {protocolVersion:1,agentCapabilities:{}};
}).connect(ndJsonStream(Writable.toWeb(process.stdout),Readable.toWeb(process.stdin)));
`;
  await writeFile(executable, source, { mode: 0o700 });
  try {
    await run(
      {
        executable,
        cwd: root,
        env: process.env,
        onStderr: () => {},
        readProcessIdentity: async (pid) => {
          try {
            process.kill(pid, 0);
            return `fixture:${pid}`;
          } catch {
            return undefined;
          }
        },
      },
      root,
    );
  } finally {
    // A failing assertion must not leak the real fixtures.
    for (const name of ['pid', 'helper-pid']) {
      try {
        const pid = Number(await readFile(join(root, name), 'utf8'));
        await terminateProcessTree({
          pid,
          signal: 'SIGKILL',
          fallback: () => process.kill(pid, 'SIGKILL'),
        });
      } catch (error) {
        if (!['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      }
    }
    await rm(root, { recursive: true, force: true });
  }
}

const initialize = (owner: AcpConnectionOwner) =>
  Promise.race([
    owner.connection.agent.request(methods.agent.initialize, {
      protocolVersion: 1,
      clientCapabilities: {},
    }),
    owner.failed,
  ]);

async function pid(root: string, name = 'pid') {
  return Number(await readFile(join(root, name), 'utf8'));
}

async function assertStopped(root: string, name = 'pid') {
  const processId = await pid(root, name);
  assert.throws(() => process.kill(processId, 0), { code: 'ESRCH' });
}

test(
  'owner remains connected between operations and shares concurrent disposal',
  { timeout: 10_000 },
  () =>
    fixture('idle', async (input, root) => {
      const owner = createAcpConnection(input);
      try {
        await initialize(owner);
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(process.kill(await pid(root), 0), true);
        assert.equal(owner.connection.signal.aborted, false);
        await initialize(owner);
        const first = owner.dispose();
        assert.equal(owner.dispose(), first);
        await first;
        await owner.closed;
        await owner.dispose();
        assert.equal(owner.connection.signal.aborted, true);
        await assertStopped(root);
      } finally {
        await owner.dispose();
      }
    }),
);

test('unexpected EOF and unsupported batches expose sanitized failure and retain cleanup ownership', {
  timeout: 15_000,
}, async () => {
  for (const scenario of ['eof', 'unsupported-batch']) {
    await fixture(scenario, async (input, root) => {
      const owner = createAcpConnection(input);
      try {
        if (scenario === 'eof') void initialize(owner).catch(() => {});
        await assert.rejects(owner.failed, {
          code: 'connection_failed',
          message: 'ACP connection: connection_failed',
        });
        assert.equal(process.kill(await pid(root), 0), true);
      } finally {
        await owner.dispose();
      }
      await assertStopped(root);
    });
  }
});

test(
  'unexpected process exit and idle failure are observed without an active request',
  { timeout: 10_000 },
  () =>
    fixture('idle', async (input, root) => {
      const owner = createAcpConnection(input);
      try {
        await initialize(owner);
        process.kill(await pid(root), 'SIGKILL');
        await owner.closed;
        // No request was waiting for failure when the process exited.
        await new Promise<void>((resolve) => setImmediate(resolve));
        await assert.rejects(owner.failed, { code: 'connection_failed' });
      } finally {
        await owner.dispose();
      }
      await assertStopped(root);
    }),
);

test('synchronous and asynchronous spawn failures are sanitized', { timeout: 10_000 }, async () => {
  const input = {
    executable: '',
    cwd: tmpdir(),
    env: process.env,
    onStderr: () => {},
  };
  assert.throws(() => createAcpConnection(input), {
    code: 'executable_unavailable',
    message: 'ACP connection: executable_unavailable',
  });
  const owner = createAcpConnection({
    ...input,
    executable: '/missing/private-acp-program',
  });
  await assert.rejects(owner.failed, {
    code: 'executable_unavailable',
    message: 'ACP connection: executable_unavailable',
  });
  await owner.dispose();
  await owner.closed;
  await assert.rejects(
    withAcpConnection({ ...input, signal: new AbortController().signal }, async () => {}),
    {
      failure: 'executable_unavailable',
      message: 'ACP setup: executable_unavailable',
    },
  );
});

test('stderr handler failures do not leak private diagnostics', { timeout: 10_000 }, () =>
  fixture('idle', async (input, root) => {
    const owner = createAcpConnection({
      ...input,
      onStderr() {
        throw new Error('private handler diagnostic');
      },
    });
    try {
      await assert.rejects(owner.failed, {
        message: 'ACP connection: connection_failed',
      });
    } finally {
      await owner.dispose();
    }
    await assertStopped(root);
  }),
);

test('setup cancellation waits for server and helper cleanup', { timeout: 15_000 }, () =>
  fixture('helper', async (input, root) => {
    const controller = new AbortController();
    await assert.rejects(
      withAcpConnection(
        {
          ...input,
          signal: controller.signal,
          onStderr() {
            controller.abort();
          },
        },
        async () => new Promise(() => {}),
      ),
      { name: 'AbortError' },
    );
    await assertStopped(root);
    await assertStopped(root, 'helper-pid');
  }),
);

test('owner disposal also terminates an escaped helper', { timeout: 15_000 }, () =>
  fixture('escaped-helper', async (input, root) => {
    const owner = createAcpConnection(input);
    await initialize(owner);
    await owner.dispose();
    await assertStopped(root);
    await assertStopped(root, 'helper-pid');
  }),
);

test('failed disposal retains the owner even after direct child closure and can be retried', {
  timeout: 25_000,
}, async (t) => {
  await fixture('helper', async (input, root) => {
    let restoreKill: (() => void) | undefined;
    let retained: AcpConnectionOwner | undefined;
    try {
      await assert.rejects(
        withAcpConnection(
          { ...input, signal: new AbortController().signal },
          async (connection) => {
            await connection.agent.request(methods.agent.initialize, {
              protocolVersion: 1,
              clientCapabilities: {},
            });
            const processId = await pid(root);
            const originalKill = process.kill.bind(process);
            const mockedKill = t.mock.method(
              process,
              'kill',
              (target: number, signal?: NodeJS.Signals | number) => {
                if (target === -processId && signal !== 0) {
                  throw Object.assign(new Error('private OS diagnostic'), {
                    code: 'EPERM',
                  });
                }
                return originalKill(target, signal);
              },
            );
            restoreKill = () => mockedKill.mock.restore();
          },
        ),
        (error: unknown) => {
          assert.ok(error instanceof AcpSetupCleanupError);
          assert.equal(error.failure, 'cleanup_failed');
          assert.equal(error.message, 'ACP setup: cleanup_failed');
          retained = error.owner;
          return true;
        },
      );
      assert.ok(retained);
      await retained.closed;
      await assert.rejects(retained.failed, (error: unknown) => {
        assert.ok(error instanceof AcpConnectionError);
        assert.equal(error.code, 'cleanup_failed');
        return true;
      });
      await assertStopped(root);
      assert.equal(process.kill(await pid(root, 'helper-pid'), 0), true);
      assert.ok(restoreKill);
      restoreKill();
      restoreKill = undefined;
      await retained.dispose();
      await retained.dispose();
      await assertStopped(root, 'helper-pid');
    } finally {
      restoreKill?.();
      await retained?.dispose();
    }
  });
});

test('a failed escaped-helper kill must not release ownership', { timeout: 15_000 }, async (t) => {
  await fixture('escaped-helper', async (input, root) => {
    const owner = createAcpConnection(input);
    let restoreKill: (() => void) | undefined;
    try {
      await initialize(owner);
      const helperId = await pid(root, 'helper-pid');
      const parentId = await pid(root);
      const originalKill = process.kill.bind(process);
      let denyHelperKill = true;
      let releasedGroupSignals = 0;
      const mockedKill = t.mock.method(
        process,
        'kill',
        (target: number, signal?: NodeJS.Signals | number) => {
          if (target === -parentId && signal !== 0 && !denyHelperKill) releasedGroupSignals++;
          if (target === helperId && signal === 'SIGKILL' && denyHelperKill) {
            throw Object.assign(new Error('private escaped-helper diagnostic'), { code: 'EPERM' });
          }
          return originalKill(target, signal);
        },
      );
      restoreKill = () => mockedKill.mock.restore();
      await assert.rejects(owner.dispose(), { code: 'cleanup_failed' });
      assert.equal(process.kill(helperId, 0), true);
      await assertStopped(root);
      denyHelperKill = false;
      await owner.dispose();
      assert.equal(releasedGroupSignals, 0);
      await assertStopped(root, 'helper-pid');
    } finally {
      restoreKill?.();
      await owner.dispose();
    }
  });
});

test('retained escaped process with a changed identity is never signaled as the original PID', {
  timeout: 20_000,
}, async (t) => {
  await fixture('escaped-helper', async (input, root) => {
    let identity = 'original-process-lifetime';
    const owner = createAcpConnection({
      ...input,
      readProcessIdentity: async () => identity,
    });
    let restoreKill: (() => void) | undefined;
    try {
      await initialize(owner);
      const helperId = await pid(root, 'helper-pid');
      const originalKill = process.kill.bind(process);
      let replacementSignals = 0;
      const mockedKill = t.mock.method(
        process,
        'kill',
        (target: number, signal?: NodeJS.Signals | number) => {
          if (target === helperId && signal !== 0) {
            if (identity === 'replacement-process-lifetime') replacementSignals++;
            throw Object.assign(new Error('denied'), { code: 'EPERM' });
          }
          return originalKill(target, signal);
        },
      );
      restoreKill = () => mockedKill.mock.restore();
      await assert.rejects(owner.dispose(), { code: 'cleanup_failed' });
      // Model an authoritative OS identity query reporting PID reuse.
      identity = 'replacement-process-lifetime';
      await owner.dispose();
      assert.equal(replacementSignals, 0);
      assert.equal(process.kill(helperId, 0), true);
    } finally {
      restoreKill?.();
      await owner.dispose();
    }
  });
});

test('unknown escaped process identity retains cleanup failure without bare-PID signaling', {
  timeout: 25_000,
}, async (t) => {
  await fixture('escaped-helper', async (input, root) => {
    const owner = createAcpConnection({
      ...input,
      readProcessIdentity: async () => undefined,
    });
    let helperId: number | undefined;
    let restoreKill: (() => void) | undefined;
    try {
      await initialize(owner);
      helperId = await pid(root, 'helper-pid');
      const originalKill = process.kill.bind(process);
      let helperSignals = 0;
      const mockedKill = t.mock.method(
        process,
        'kill',
        (target: number, signal?: NodeJS.Signals | number) => {
          if (target === helperId && signal !== 0) helperSignals++;
          return originalKill(target, signal);
        },
      );
      restoreKill = () => mockedKill.mock.restore();
      await assert.rejects(owner.dispose(), { code: 'cleanup_failed' });
      await assert.rejects(owner.dispose(), { code: 'cleanup_failed' });
      assert.equal(helperSignals, 0);
      assert.equal(process.kill(helperId, 0), true);
    } finally {
      restoreKill?.();
      if (helperId) process.kill(helperId, 'SIGKILL');
      await owner.dispose();
    }
  });
});

test('retained-descendant retry respects the beforeSignal admission gate', async (t) => {
  const descendants = new RetainedProcessTreeDescendants(async () => undefined);
  t.mock.method(descendants, 'terminateRetained', async () => {
    assert.fail('rejected termination must not reach a destructive operation');
  });
  assert.equal(
    await terminateProcessTree({
      pid: process.pid,
      signal: 'SIGKILL',
      descendants,
      onlyRetainedDescendants: true,
      beforeSignal: async () => false,
    }),
    false,
  );
});
