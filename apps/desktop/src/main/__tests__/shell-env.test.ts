/**
 * PR #1316 review coverage: lock the per-shell capture-command quoting, the
 * marker-adjacency contract (which is why the dead xonsh branch was dropped),
 * and the public capture path. Same `node:test` + `node:assert/strict` layout
 * as `build-info.test.ts`.
 */

import { strict as assert } from 'node:assert';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import {
  buildCaptureCommand,
  buildMarkerRegex,
  resolveShellEnv,
  selectLoginShell,
} from '../shell-env.js';

const MARK = '0123456789ab';

function snapshotEnv(): () => void {
  const before = new Map<string, string>();
  for (const [key, value] of Object.entries(process.env)) {
    before.set(key, value as string);
  }
  return () => {
    for (const key of Object.keys(process.env)) {
      if (!before.has(key)) delete process.env[key];
    }
    for (const [key, value] of before) process.env[key] = value;
  };
}

async function createFakeShell(body: string): Promise<{
  path: string;
  cleanup: () => Promise<void>;
}> {
  const directory = await mkdtemp(join(tmpdir(), 'maka-shell-env-'));
  const path = join(directory, 'fake-shell');
  await writeFile(path, `#!/bin/sh\n${body}\n`, { mode: 0o700 });
  return {
    path,
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

async function readPid(path: string): Promise<number> {
  const pid = Number.parseInt(await readFile(path, 'utf8'), 10);
  assert.ok(Number.isInteger(pid) && pid > 0);
  return pid;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

async function assertProcessExited(pid: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return;
    await delay(20);
  }
  assert.fail(`process ${pid} remained alive after shell capture settled`);
}

function terminateIfAlive(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    process.kill(pid, 'SIGKILL');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}

describe('resolveShellEnv', () => {
  it(
    'imports the login PATH without importing application control variables',
    { skip: process.platform === 'win32' },
    async () => {
      const restoreEnv = snapshotEnv();
      const shell = await createFakeShell(`
(
  trap '' HUP TERM
  sleep 60
) </dev/null >/dev/null 2>&1 &
printf '%s' "$!" > "$SHELL_ENV_TEST_PID_FILE"
export PATH='/resolved/bin:/usr/bin'
export MAKA_E2E_FIXTURE='first-run'
export VITE_DEV_SERVER_URL='https://example.invalid/renderer'
export XDG_RUNTIME_DIR='/shell/runtime'
exec /bin/sh -c "$4"
`);
      const pidFile = `${shell.path}.pid`;
      let descendantPid: number | undefined;
      try {
        process.env.SHELL = shell.path;
        process.env.SHELL_ENV_TEST_PID_FILE = pidFile;
        process.env.PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
        process.env.XDG_RUNTIME_DIR = '/original/runtime';
        delete process.env.TERM;
        delete process.env.COLORTERM;
        delete process.env.MAKA_SKIP_SHELL_ENV;
        delete process.env.MAKA_E2E_FIXTURE;
        delete process.env.VITE_DEV_SERVER_URL;
        delete process.env.ELECTRON_RUN_AS_NODE;
        delete process.env.ELECTRON_NO_ATTACH_CONSOLE;

        await resolveShellEnv();
        descendantPid = await readPid(pidFile);

        assert.equal(process.env.PATH, '/resolved/bin:/usr/bin');
        assert.equal(process.env.MAKA_E2E_FIXTURE, undefined);
        assert.equal(process.env.VITE_DEV_SERVER_URL, undefined);
        assert.equal(process.env.XDG_RUNTIME_DIR, '/original/runtime');
        assert.equal(process.env.ELECTRON_RUN_AS_NODE, undefined);
        assert.equal(process.env.ELECTRON_NO_ATTACH_CONSOLE, undefined);
        await assertProcessExited(descendantPid);
      } finally {
        terminateIfAlive(descendantPid);
        restoreEnv();
        await shell.cleanup();
      }
    },
  );

  it(
    'keeps the inherited PATH and does not log shell stderr when capture fails',
    { skip: process.platform === 'win32' },
    async () => {
      const restoreEnv = snapshotEnv();
      const shell = await createFakeShell(`
(
  trap '' HUP TERM
  sleep 60
) </dev/null >/dev/null 2>&1 &
printf '%s' "$!" > "$SHELL_ENV_TEST_PID_FILE"
printf 'secret-from-shell-startup' >&2
exit 23
`);
      const pidFile = `${shell.path}.pid`;
      let descendantPid: number | undefined;
      const warnings: string[] = [];
      const originalWarn = console.warn;
      console.warn = (...args: unknown[]) => warnings.push(args.map(String).join(' '));
      try {
        process.env.SHELL = shell.path;
        process.env.SHELL_ENV_TEST_PID_FILE = pidFile;
        process.env.PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
        delete process.env.TERM;
        delete process.env.COLORTERM;
        delete process.env.MAKA_SKIP_SHELL_ENV;

        await resolveShellEnv();
        descendantPid = await readPid(pidFile);

        assert.equal(process.env.PATH, '/usr/bin:/bin:/usr/sbin:/sbin');
        assert.match(warnings.join('\n'), /exited with code 23/);
        assert.doesNotMatch(warnings.join('\n'), /secret-from-shell-startup/);
        await assertProcessExited(descendantPid);
      } finally {
        terminateIfAlive(descendantPid);
        console.warn = originalWarn;
        restoreEnv();
        await shell.cleanup();
      }
    },
  );

  it(
    'kills login-shell descendants when capture times out',
    { skip: process.platform === 'win32' },
    async () => {
      const restoreEnv = snapshotEnv();
      const shell = await createFakeShell(`
(
  trap '' HUP TERM
  sleep 60
) </dev/null >/dev/null 2>&1 &
printf '%s' "$!" > "$SHELL_ENV_TEST_PID_FILE"
wait
`);
      const pidFile = `${shell.path}.pid`;
      let descendantPid: number | undefined;
      const originalWarn = console.warn;
      console.warn = () => {};
      try {
        process.env.SHELL = shell.path;
        process.env.SHELL_ENV_TEST_PID_FILE = pidFile;
        process.env.PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
        delete process.env.TERM;
        delete process.env.COLORTERM;
        delete process.env.MAKA_SKIP_SHELL_ENV;

        await resolveShellEnv(1_000);
        descendantPid = await readPid(pidFile);

        await assertProcessExited(descendantPid);
        assert.equal(process.env.PATH, '/usr/bin:/bin:/usr/sbin:/sbin');
      } finally {
        terminateIfAlive(descendantPid);
        console.warn = originalWarn;
        restoreEnv();
        await shell.cleanup();
      }
    },
  );

  it(
    'does not execute the shell when MAKA_SKIP_SHELL_ENV is set',
    async () => {
      const restoreEnv = snapshotEnv();
      const shell = await createFakeShell(`
printf 'executed' > "$SHELL_ENV_TEST_SENTINEL_FILE"
exit 0
`);
      const sentinelFile = `${shell.path}.executed`;
      try {
        process.env.SHELL = shell.path;
        process.env.SHELL_ENV_TEST_SENTINEL_FILE = sentinelFile;
        process.env.PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
        process.env.MAKA_SKIP_SHELL_ENV = '1';
        delete process.env.TERM;
        delete process.env.COLORTERM;

        await resolveShellEnv();

        assert.equal(process.env.PATH, '/usr/bin:/bin:/usr/sbin:/sbin');
        await assert.rejects(readFile(sentinelFile));
      } finally {
        restoreEnv();
        await shell.cleanup();
      }
    },
  );

  it(
    'bounds shell output instead of buffering until the global timeout',
    { skip: process.platform === 'win32' },
    async () => {
      const restoreEnv = snapshotEnv();
      const shell = await createFakeShell(`
while :; do
  printf '0123456789abcdef0123456789abcdef'
done
`);
      const warnings: string[] = [];
      const originalWarn = console.warn;
      console.warn = (...args: unknown[]) => warnings.push(args.map(String).join(' '));
      try {
        process.env.SHELL = shell.path;
        process.env.PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
        delete process.env.TERM;
        delete process.env.COLORTERM;
        delete process.env.MAKA_SKIP_SHELL_ENV;

        await resolveShellEnv(2_000);

        assert.match(warnings.join('\n'), /shell output exceeded 65536 bytes/);
        assert.equal(process.env.PATH, '/usr/bin:/bin:/usr/sbin:/sbin');
      } finally {
        console.warn = originalWarn;
        restoreEnv();
        await shell.cleanup();
      }
    },
  );
});

describe('selectLoginShell', () => {
  it('prefers the inherited shell over the account shell', () => {
    assert.equal(selectLoginShell('/bin/bash', '/bin/fish', 'darwin'), '/bin/bash');
  });

  it('uses the OS account shell when GUI launch omitted SHELL', () => {
    assert.equal(selectLoginShell(undefined, '/bin/fish', 'linux'), '/bin/fish');
  });

  it('uses platform-appropriate defaults only when neither source has a shell', () => {
    assert.equal(selectLoginShell(undefined, undefined, 'darwin'), '/bin/zsh');
    assert.equal(selectLoginShell(undefined, undefined, 'linux'), '/bin/sh');
  });
});

describe('buildCaptureCommand', () => {
  describe('POSIX family (bash / zsh / fish / sh)', () => {
    it('escapes the executable and produces a flush-marker payload', () => {
      const { command, shellArgs } = buildCaptureCommand('bash', "/Users/Bob's/node", MARK);
      assert.deepEqual(shellArgs, ['-i', '-l', '-c']);
      assert.equal(
        command,
        `'/Users/Bob'\\''s/node' -p '"${MARK}" + JSON.stringify({ PATH: process.env.PATH }) + "${MARK}"'`,
      );
      // The payload concatenates mark + JSON + mark with no separator, so the
      // emitted bytes are `<mark>{...}<mark>` — markers flush against the
      // braces the capture regex anchors on.
      const emitted = `${MARK}${JSON.stringify({ PATH: '/usr/bin' })}${MARK}`;
      const match = buildMarkerRegex(MARK).exec(emitted);
      assert.ok(match);
      assert.equal(match[1], JSON.stringify({ PATH: '/usr/bin' }));
    });
  });

  describe('PowerShell', () => {
    it('uses -Login -Command and doubles an embedded apostrophe', () => {
      const { command, shellArgs } = buildCaptureCommand('pwsh', "/Users/Bob's/node", MARK);
      assert.deepEqual(shellArgs, ['-Login', '-Command']);
      // PowerShell single-quoted strings escape `'` as `''`.
      assert.equal(
        command,
        `& '/Users/Bob''s/node' -p '''${MARK}'' + JSON.stringify({ PATH: process.env.PATH }) + ''${MARK}'''`,
      );
    });

    it('matches powershell-preview too and leaves an apostrophe-free path untouched', () => {
      const { command, shellArgs } = buildCaptureCommand('powershell-preview', '/usr/bin/node', MARK);
      assert.deepEqual(shellArgs, ['-Login', '-Command']);
      assert.equal(
        command,
        `& '/usr/bin/node' -p '''${MARK}'' + JSON.stringify({ PATH: process.env.PATH }) + ''${MARK}'''`,
      );
    });
  });

  describe('nu', () => {
    it('uses a raw string and -i -l -c (embedded quotes are a documented edge case)', () => {
      const { command, shellArgs } = buildCaptureCommand('nu', '/usr/bin/node', MARK);
      assert.deepEqual(shellArgs, ['-i', '-l', '-c']);
      assert.equal(
        command,
        `^'/usr/bin/node' -p '"${MARK}" + JSON.stringify({ PATH: process.env.PATH }) + "${MARK}"'`,
      );
    });
  });

});
