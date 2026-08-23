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
import { EventEmitter } from 'node:events';
import { access, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { after, describe, it } from 'node:test';
import { bumpedAutoupdateVersion } from './package-windows-autoupdate-next.mjs';
import { validateWindowsUpgradeBaseline } from './prepare-windows-upgrade-baseline.mjs';
import {
  diffTreeManifests,
  directoryTreeManifest,
  runCommand,
  waitForDevToolsPort,
  waitForUsableRenderer,
} from './verify-packaged-app.mjs';
import { waitForInstalledProductVersion } from './verify-windows-autoupdate.mjs';
import {
  completeInstalledApplicationUninstall,
  installerVersion,
  listInstalledProcesses,
  terminateInstalledProcesses,
  waitForInstalledProcessAppearance,
  waitForInstalledProcessesToExit,
  waitForUninstallRegistrationToClear,
} from './verify-windows-installer-lifecycle.mjs';

// Tests for the shared release-verification helpers. Everything here is
// platform-neutral on purpose: the Windows lanes execute these helpers for
// real, and this file proves their contracts on every PR that touches them.

const temporaryRoots = [];
const delay = (milliseconds) =>
  new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));

it('uses the product SemVer contract throughout Windows release verification', () => {
  assert.equal(installerVersion('Maka-1.2.3-beta.2-win-x64.exe'), '1.2.3-beta.2');
  assert.equal(bumpedAutoupdateVersion('1.2.3-beta.2'), '1.2.3');
  assert.equal(bumpedAutoupdateVersion('1.2.3'), '1.2.4');

  const baseline = {
    version: '1.2.3-beta.1',
    tag: 'v1.2.3-beta.1',
    assetName: 'Maka-1.2.3-beta.1-win-x64.exe',
    sha256: 'a'.repeat(64),
  };
  assert.equal(validateWindowsUpgradeBaseline(baseline, '1.2.3-beta.2'), baseline);
  assert.throws(
    () => validateWindowsUpgradeBaseline(baseline, '1.2.3-alpha.1'),
    /must be older than the candidate/u,
  );
});

async function makeTree(shape) {
  const root = await mkdtemp(join(tmpdir(), 'maka-harness-test-'));
  temporaryRoots.push(root);
  for (const [relative, content] of Object.entries(shape)) {
    const absolute = join(root, relative);
    if (content === null) {
      await mkdir(absolute, { recursive: true });
    } else {
      await mkdir(join(absolute, '..'), { recursive: true });
      await writeFile(absolute, content);
    }
  }
  return root;
}

after(async () => {
  for (const root of temporaryRoots) {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

describe('directoryTreeManifest', () => {
  it('returns sorted POSIX-relative paths with sha256 content hashes', async () => {
    const root = await makeTree({
      'b.txt': 'bee',
      'a/nested.txt': 'nested',
      'a/z.txt': 'zed',
    });
    const manifest = await directoryTreeManifest(root);
    assert.deepEqual(
      manifest.map((entry) => entry.path),
      ['a/nested.txt', 'a/z.txt', 'b.txt'],
    );
    for (const entry of manifest) {
      assert.match(entry.sha256, /^[0-9a-f]{64}$/);
    }
  });

  it('records empty directories so their loss is visible', async () => {
    const root = await makeTree({ 'a/file.txt': 'x', 'a/empty': null });
    const manifest = await directoryTreeManifest(root);
    assert.deepEqual(
      manifest.map((entry) => entry.path),
      ['a/empty/', 'a/file.txt'],
    );
    assert.equal(manifest.find((entry) => entry.path === 'a/empty/').sha256, null);
  });

  it('hashes content, not names: same names different bytes differ', async () => {
    const left = await directoryTreeManifest(await makeTree({ 'f.txt': 'one' }));
    const right = await directoryTreeManifest(await makeTree({ 'f.txt': 'two' }));
    assert.notEqual(left[0].sha256, right[0].sha256);
  });

  it('throws on non-regular entries instead of skipping them', async (t) => {
    const root = await makeTree({ 'real.txt': 'x' });
    try {
      await symlink(join(root, 'real.txt'), join(root, 'link.txt'));
    } catch (error) {
      // Windows without Developer Mode cannot create symlinks; the guard
      // itself is platform-neutral readdir dirent logic.
      if (error.code === 'EPERM') return t.skip('symlink creation requires privilege here');
      throw error;
    }
    await assert.rejects(
      () => directoryTreeManifest(root),
      /Unsupported directory entry .*link\.txt/,
    );
  });
});

describe('diffTreeManifests', () => {
  const manifest = (entries) => entries.map(([path, sha256]) => ({ path, sha256 }));
  const cases = [
    {
      name: 'identical manifests diff empty',
      before: manifest([
        ['a.txt', '1'.repeat(64)],
        ['b/c.txt', '2'.repeat(64)],
      ]),
      after: manifest([
        ['a.txt', '1'.repeat(64)],
        ['b/c.txt', '2'.repeat(64)],
      ]),
      expected: { missing: [], extra: [], changed: [] },
    },
    {
      name: 'a lost file is missing',
      before: manifest([['a.txt', '1'.repeat(64)]]),
      after: manifest([]),
      expected: { missing: ['a.txt'], extra: [], changed: [] },
    },
    {
      name: 'a new file is extra',
      before: manifest([]),
      after: manifest([['n.txt', '3'.repeat(64)]]),
      expected: { missing: [], extra: ['n.txt'], changed: [] },
    },
    {
      name: 'different bytes at the same path are changed',
      before: manifest([['a.txt', '1'.repeat(64)]]),
      after: manifest([['a.txt', '4'.repeat(64)]]),
      expected: { missing: [], extra: [], changed: ['a.txt'] },
    },
    {
      name: 'a lost empty directory is missing',
      before: manifest([['a/empty/', null]]),
      after: manifest([]),
      expected: { missing: ['a/empty/'], extra: [], changed: [] },
    },
  ];
  for (const { name, before, after: afterManifest, expected } of cases) {
    it(name, () => {
      assert.deepEqual(diffTreeManifests(before, afterManifest), expected);
    });
  }
});

describe('runCommand', () => {
  it('kills the child and rejects when timeoutMs elapses', async () => {
    const root = await makeTree({});
    const sentinel = join(root, 'child-survived.txt');
    await assert.rejects(
      () =>
        runCommand(
          process.execPath,
          [
            '-e',
            "setTimeout(() => require('node:fs').writeFileSync(process.argv[1], 'leaked'), 600)",
            sentinel,
          ],
          { timeoutMs: 100 },
        ),
      /did not finish within 100ms/,
    );
    await delay(800);
    await assert.rejects(() => access(sentinel), { code: 'ENOENT' });
  });

  it('resolves stdout for a completing command without a timeout', async () => {
    const { stdout } = await runCommand(process.execPath, ['-e', "process.stdout.write('ok')"]);
    assert.equal(stdout, 'ok');
  });
});

describe('waitForDevToolsPort', () => {
  const makeChild = () => {
    const child = new EventEmitter();
    child.stderr = new PassThrough();
    child.exitCode = null;
    return child;
  };

  it('resolves the announced port', async () => {
    const child = makeChild();
    const wait = waitForDevToolsPort(child, { timeoutMs: 2_000 });
    child.stderr.write('DevTools listening on ws://127.0.0.1:54321/devtools/browser/abc\n');
    assert.equal(await wait, 54321);
  });

  it('rejects when the child exits before announcing', async () => {
    const child = makeChild();
    const wait = waitForDevToolsPort(child, { timeoutMs: 2_000 });
    child.exitCode = 1;
    child.emit('exit');
    await assert.rejects(() => wait, /exited before announcing/);
  });
});

describe('waitForUsableRenderer', () => {
  it('fails fast when the child is already dead', async () => {
    await assert.rejects(
      () =>
        waitForUsableRenderer(
          'ws://127.0.0.1:1/devtools/page/x',
          { exitCode: 1 },
          {
            deadlineMs: 5_000,
            description: 'T',
          },
        ),
      /T exited before it became usable/,
    );
  });

  it('retries failed probes and fails only at the deadline', async () => {
    const startedAt = Date.now();
    await assert.rejects(
      () =>
        waitForUsableRenderer(
          'ws://127.0.0.1:1/devtools/page/x',
          { exitCode: null },
          {
            deadlineMs: 700,
            description: 'T',
          },
        ),
      /T did not become usable within 700ms/,
    );
    const elapsed = Date.now() - startedAt;
    assert.ok(elapsed >= 700, `deadline respected: ${elapsed}`);
    assert.ok(elapsed < 30_000, `no runaway: ${elapsed}`);
  });

  it('caps a half-open WebSocket probe to the remaining deadline budget', async () => {
    const sockets = new Set();
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });
    await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const startedAt = Date.now();
    try {
      await assert.rejects(
        () =>
          waitForUsableRenderer(
            `ws://127.0.0.1:${address.port}/devtools/page/hung`,
            { exitCode: null },
            { deadlineMs: 200, description: 'T' },
          ),
        /T did not become usable within 200ms/,
      );
      const elapsed = Date.now() - startedAt;
      assert.ok(elapsed < 2_000, `inner probe exceeded the outer deadline budget: ${elapsed}`);
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolvePromise) => server.close(resolvePromise));
    }
  });
});

describe('waitForInstalledProcessesToExit', () => {
  it('returns once an enumeration reports no processes', async () => {
    const snapshots = [[{ processId: 1, name: 'Maka.exe' }], []];
    await waitForInstalledProcessesToExit('C:/nowhere', {
      listProcesses: async () => snapshots.shift(),
      timeoutMs: 2_000,
      pollIntervalMs: 10,
    });
  });

  it('never treats a failed enumeration as empty: rejects at the deadline', async () => {
    await assert.rejects(
      () =>
        waitForInstalledProcessesToExit('C:/nowhere', {
          listProcesses: async () => {
            throw new Error('wmi stalled');
          },
          timeoutMs: 200,
          pollIntervalMs: 10,
        }),
      /Could not enumerate installed Maka processes within 200ms: wmi stalled/,
    );
  });
});

describe('listInstalledProcesses', () => {
  it('bounds a WMI round to ten seconds so polling can retry', async () => {
    let observedTimeout;
    const processes = await listInstalledProcesses('C:/nowhere', {
      run: async (_command, _args, options) => {
        observedTimeout = options.timeoutMs;
        return { stdout: '', stderr: '' };
      },
    });
    assert.deepEqual(processes, []);
    assert.equal(observedTimeout, 10_000);
  });
});

describe('waitForInstalledProcessAppearance', () => {
  it('survives a failed probe and returns the later successful match', async () => {
    // The regression run 32340493254 rejected on the first wedged
    // enumeration; the contract is failure-then-success within the deadline.
    const probes = [
      () => Promise.reject(new Error('wmi stalled')),
      () =>
        Promise.resolve([
          { processId: 7, name: 'Maka.exe', path: 'C:/nowhere/installed/Maka.exe' },
        ]),
    ];
    const matched = await waitForInstalledProcessAppearance('C:/nowhere/installed', 'Maka.exe', {
      listProcesses: () => probes.shift()(),
      timeoutMs: 2_000,
      pollIntervalMs: 10,
    });
    assert.deepEqual(
      matched.map((processInfo) => processInfo.processId),
      [7],
    );
  });

  it('matches by executable basename, case-insensitively', async () => {
    const matched = await waitForInstalledProcessAppearance('C:/nowhere/installed', 'Maka.exe', {
      listProcesses: async () => [
        { processId: 1, name: 'other.exe', path: 'C:/nowhere/installed/other.exe' },
        { processId: 2, name: 'MAKA.EXE', path: 'C:/nowhere/installed/MAKA.EXE' },
      ],
      timeoutMs: 2_000,
      pollIntervalMs: 10,
    });
    assert.deepEqual(
      matched.map((processInfo) => processInfo.processId),
      [2],
    );
  });

  it('reports the last probe error only when no later enumeration succeeds', async () => {
    await assert.rejects(
      () =>
        waitForInstalledProcessAppearance('C:/nowhere/installed', 'Maka.exe', {
          listProcesses: async () => {
            throw new Error('wmi stalled');
          },
          timeoutMs: 150,
          pollIntervalMs: 10,
        }),
      /did not appear among installed processes within 150ms\.\nlast probe error: wmi stalled/,
    );
  });
});

describe('waitForInstalledProductVersion', () => {
  it('retries a stalled PowerShell read within the outer deadline', async () => {
    const observedTimeouts = [];
    const results = [new Error('powershell stalled'), { stdout: '0.1.12', stderr: '' }];
    const version = await waitForInstalledProductVersion('C:/installed/Maka.exe', {
      run: async (_command, _args, options) => {
        observedTimeouts.push(options.timeoutMs);
        const result = results.shift();
        if (result instanceof Error) throw result;
        return result;
      },
      timeoutMs: 60_000,
      pollIntervalMs: 1,
    });
    assert.equal(version, '0.1.12');
    assert.equal(observedTimeouts.length, 2);
    assert.ok(observedTimeouts.every((timeout) => timeout > 0 && timeout <= 10_000));
  });
});

describe('terminateInstalledProcesses', () => {
  const process7 = { processId: 7, name: 'Maka.exe', path: 'C:/nowhere/installed/Maka.exe' };

  it('tolerates exit 128 and an overrun kill, then proves exit', async () => {
    const events = [];
    const failures = [
      new Error('taskkill /PID 7 /T /F failed with exit code 128'),
      new Error('taskkill /PID 8 /T /F did not finish within 30000ms'),
    ];
    await terminateInstalledProcesses('C:/nowhere/installed', {
      listProcesses: async () => [process7, { ...process7, processId: 8 }],
      run: async (command, args) => {
        events.push(`${command}:${args[1]}`);
        throw failures.shift();
      },
      waitForExit: async () => {
        events.push('wait');
      },
    });
    // Both mechanism failures were tolerated and the authoritative exit
    // wait still ran.
    assert.deepEqual(events, ['taskkill:7', 'taskkill:8', 'wait']);
  });

  it('lets the exit proof decide after any taskkill mechanism failure', async () => {
    let exitProofRan = false;
    await terminateInstalledProcesses('C:/nowhere/installed', {
      listProcesses: async () => [process7],
      run: async () => {
        throw new Error('taskkill /PID 7 /T /F failed with exit code 255');
      },
      waitForExit: async () => {
        exitProofRan = true;
      },
    });
    assert.equal(exitProofRan, true);
  });

  it('reports the exit proof and taskkill failures together when residue remains', async () => {
    await assert.rejects(
      () =>
        terminateInstalledProcesses('C:/nowhere/installed', {
          listProcesses: async () => [process7],
          run: async () => {
            throw new Error('taskkill failed with exit code 255');
          },
          waitForExit: async () => {
            throw new Error('Maka.exe (7) is still running');
          },
        }),
      (error) => {
        assert.ok(error instanceof AggregateError);
        assert.match(error.message, /did not exit after taskkill failures/);
        assert.deepEqual(
          error.errors.map((failure) => failure.message),
          ['Maka.exe (7) is still running', 'taskkill failed with exit code 255'],
        );
        return true;
      },
    );
  });

  it('retries a transient enumeration failure before killing and proving exit', async () => {
    const events = [];
    let attempts = 0;
    await terminateInstalledProcesses('C:/nowhere/installed', {
      listProcesses: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('wmi stalled');
        return [process7];
      },
      run: async () => {
        events.push('kill');
        return { stdout: '', stderr: '' };
      },
      waitForExit: async () => events.push('wait'),
      pollIntervalMs: 1,
    });
    assert.equal(attempts, 2);
    assert.deepEqual(events, ['kill', 'wait']);
  });
});

describe('completeInstalledApplicationUninstall', () => {
  it('runs the uninstaller and waits for both cleanup barriers in order', async () => {
    const events = [];
    await completeInstalledApplicationUninstall('C:/installed', 'C:/installed/uninstall.exe', {
      requirePath: async () => events.push('access'),
      run: async () => {
        events.push('uninstall');
        return { stdout: '', stderr: '' };
      },
      waitForMissing: async () => events.push('files-missing'),
      waitForRegistration: async () => events.push('registration-clear'),
    });
    assert.deepEqual(events, ['access', 'uninstall', 'files-missing', 'registration-clear']);
  });

  it('still proves both barriers when a detached uninstaller is already gone', async () => {
    const events = [];
    await completeInstalledApplicationUninstall('C:/installed', 'C:/installed/uninstall.exe', {
      requirePath: async () => {
        const error = new Error('missing');
        error.code = 'ENOENT';
        throw error;
      },
      run: async () => assert.fail('a missing uninstaller must not be launched'),
      waitForMissing: async () => events.push('files-missing'),
      waitForRegistration: async () => events.push('registration-clear'),
    });
    assert.deepEqual(events, ['files-missing', 'registration-clear']);
  });
});

describe('waitForUninstallRegistrationToClear', () => {
  const runReturning = (outputs) => async () => ({ stdout: outputs.shift(), stderr: '' });

  it('returns once the registration reads empty', async () => {
    await waitForUninstallRegistrationToClear({
      run: runReturning(['0.1.11\n', '\n']),
      timeoutMs: 2_000,
      pollIntervalMs: 10,
    });
  });

  it('reports the lingering registration at the deadline', async () => {
    await assert.rejects(
      () =>
        waitForUninstallRegistrationToClear({
          run: async () => ({ stdout: '0.1.11\n', stderr: '' }),
          timeoutMs: 150,
          pollIntervalMs: 10,
        }),
      /uninstall registration \(DisplayVersion "0\.1\.11"\) is still present after 150ms/,
    );
  });

  it('tolerates probe failures but rejects with them at the deadline', async () => {
    await assert.rejects(
      () =>
        waitForUninstallRegistrationToClear({
          run: async () => {
            throw new Error('registry stalled');
          },
          timeoutMs: 150,
          pollIntervalMs: 10,
        }),
      /Could not read the Maka uninstall registration within 150ms: registry stalled/,
    );
  });
});
