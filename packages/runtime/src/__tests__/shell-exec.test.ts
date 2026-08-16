import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { existsSync, promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { killWindowsTree } from '../process-tree-terminator.js';
import { runProcessWithBoundedTail, runShellWithBoundedTail } from '../shell-exec.js';

const base = (over: Record<string, unknown> = {}) => ({
  cwd: process.cwd(),
  timeoutMs: 30_000,
  ...over,
});
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function readWhenAvailable(path: string, timeoutMs = 5_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      return await fs.readFile(path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || Date.now() >= deadline) throw error;
      await delay(20);
    }
  }
}

async function waitForProcessExit(pid: number, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
      throw error;
    }
    if (Date.now() >= deadline) throw new Error(`Detached descendant ${pid} is still running`);
    await delay(20);
  }
}

function findPwsh(): string | undefined {
  const exeNames = process.platform === 'win32' ? ['pwsh.exe'] : ['pwsh', 'pwsh-preview'];
  for (const dir of (process.env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':')) {
    if (!dir) continue;
    for (const name of exeNames) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

describe('runShellWithBoundedTail', () => {
  test('keeps only the bounded, line-aligned TAIL of large output (never killed by size)', async () => {
    const r = await runShellWithBoundedTail(
      "printf 'HEADMARK\\n'; seq 1 50; printf 'TAILMARK\\n'",
      base({ maxRetainedChars: 12 }),
    );
    assert.equal(r.exitCode, 0);
    assert.ok(r.stdout.includes('TAILMARK'), 'tail retained');
    assert.ok(!r.stdout.includes('HEADMARK'), 'head dropped — it is a tail');
    assert.ok(r.stdout.length <= 12, `tail bounded to cap, got ${r.stdout.length}`);
    assert.equal(r.stdoutTruncated, true);
  });

  test('captures stderr and a non-zero exit code as data (does not reject)', async () => {
    const r = await runShellWithBoundedTail("printf 'oops\\n' >&2; exit 3", base());
    assert.equal(r.exitCode, 3);
    assert.equal(r.stderr, 'oops\n');
    assert.equal(r.stdout, '');
  });

  test('times out a slow command, kills it, and reports timedOut', async () => {
    const r = await runShellWithBoundedTail('sleep 5', base({ timeoutMs: 150 }));
    assert.equal(r.timedOut, true);
    assert.equal(r.exitCode, 124);
  });

  test('does not spawn a process for an already-aborted invocation', async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), 'shell-exec-pre-abort-'));
    const marker = join(dir, 'spawned');
    const abort = new AbortController();
    abort.abort();
    try {
      const result = await runProcessWithBoundedTail(
        process.execPath,
        ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'spawned')`],
        base({ abortSignal: abort.signal }),
      );
      assert.equal(result.aborted, true);
      assert.equal(result.exitCode, 130);
      await assert.rejects(() => fs.readFile(marker, 'utf8'), { code: 'ENOENT' });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test('bounds output drain after the root exits while a detached descendant retains stdout', {
    skip: process.platform === 'win32' ? 'POSIX detached process-group semantics required' : false,
  }, async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), 'shell-exec-drain-'));
    const pidFile = join(dir, 'child.pid');
    let childPid: number | undefined;
    try {
      const script = `const {spawn}=require('node:child_process');const {writeFileSync}=require('node:fs');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:['ignore',process.stdout,'ignore']});child.unref();writeFileSync(${JSON.stringify(pidFile)},String(child.pid));process.stdout.write('ROOT\\n')`;
      const startedAt = Date.now();
      const result = await runProcessWithBoundedTail(
        process.execPath,
        ['-e', script],
        base({ ioDrainTimeoutMs: 100 }),
      );
      childPid = Number.parseInt(await fs.readFile(pidFile, 'utf8'), 10);
      assert.ok(Date.now() - startedAt < 2_000);
      assert.equal(result.exitCode, 0);
      assert.equal(result.stdout, 'ROOT\n');
      assert.equal(result.stdoutTruncated, true);
      assert.equal(result.stderrTruncated, false);
    } finally {
      if (childPid) {
        try {
          process.kill(-childPid, 'SIGKILL');
        } catch {
          try {
            process.kill(childPid, 'SIGKILL');
          } catch {
            /* descendant already exited */
          }
        }
      }
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test('on timeout, escalates SIGTERM->SIGKILL and resolves only after the child is actually dead', async () => {
    // A child that traps/ignores SIGTERM would, under the old "kill then resolve
    // immediately" path, keep running (and emitting) after we told the caller
    // "timed out". Now we wait for the child to actually exit (SIGKILL after the
    // grace) before resolving — proven by the heartbeat file no longer growing.
    const dir = await fs.mkdtemp(join(tmpdir(), 'shell-exec-kill-'));
    const beat = join(dir, 'beat');
    const cmd = `trap '' TERM; while true; do echo STILL; echo x >> '${beat}'; sleep 0.02; done`;
    const emits: string[] = [];
    try {
      const r = await runShellWithBoundedTail(
        cmd,
        base({
          timeoutMs: 100,
          killGraceMs: 150,
          emitOutput: (_s: string, c: string) => emits.push(c),
        }),
      );
      assert.equal(r.timedOut, true);
      assert.equal(r.exitCode, 124);
      const sizeAtResolve = (await fs.stat(beat)).size;
      const emitsAtResolve = emits.length;
      await delay(300); // a live child would append ~15 more lines in this window
      const sizeLater = (await fs.stat(beat)).size;
      assert.ok(
        sizeLater - sizeAtResolve <= 2, // tolerate at most one in-flight append
        `child kept writing after resolve (grew ${sizeLater - sizeAtResolve} bytes) — not actually killed`,
      );
      assert.equal(emits.length, emitsAtResolve, 'no emitOutput after resolve');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test('on abort, kills detached descendants of a directly spawned process', async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), 'shell-exec-tree-'));
    const pidFile = join(dir, 'child.pid');
    const parentFile = join(dir, 'parent.cjs');
    const childScript = 'setInterval(() => {}, 1000)';
    await fs.writeFile(
      parentFile,
      `
      const { spawn } = require('node:child_process');
      const { writeFileSync } = require('node:fs');
      const child = spawn(process.execPath, ['-e', ${JSON.stringify(childScript)}], {
        detached: true,
        stdio: 'ignore',
      });
      child.unref();
      writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
      setInterval(() => {}, 1000);
    `,
    );
    const abort = new AbortController();
    const running = runProcessWithBoundedTail(
      process.execPath,
      [parentFile],
      base({
        timeoutMs: 10_000,
        killGraceMs: 150,
        abortSignal: abort.signal,
      }),
    );
    try {
      const childPid = Number((await readWhenAvailable(pidFile)).trim());
      assert.ok(Number.isInteger(childPid) && childPid > 0, 'detached descendant recorded its pid');
      abort.abort();
      const r = await running;
      assert.equal(r.aborted, true);
      assert.equal(r.exitCode, 130);
      await waitForProcessExit(childPid);
    } finally {
      abort.abort();
      await running.catch(() => undefined);
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test('surfaces a safety marker (not bare empty) when an oversized no-newline line is dropped', async () => {
    // One 500-char line with no newline, cap 50: BashTailBuffer drops it whole
    // (no safe truncation boundary), so without a marker the result would look
    // like the command produced nothing.
    const r = await runShellWithBoundedTail(
      "head -c 500 /dev/zero | tr '\\0' x",
      base({ maxRetainedChars: 50 }),
    );
    assert.equal(r.exitCode, 0);
    assert.ok(!r.stdout.includes('xxxx'), 'dropped content is not leaked');
    assert.ok(r.stdout.includes('omitted for safety'), 'a recoverable safety marker is present');
    assert.equal(r.stdoutTruncated, true);
    // Shares the recovery hint with truncateToolOutput: re-run only when safe.
    assert.ok(r.stdout.includes('safe to re-run'), 'recovery guidance is conditioned on safety');
    assert.ok(r.stdout.includes('side effects'), 'warns about repeating side effects');
  });

  test('spawns a detected PowerShell explicitly with non-interactive flags (not via shell:true)', async () => {
    // /bin/echo stands in for pwsh.exe: if the spawn plan is honoured, the
    // "shell" receives the flags plus the command wrapper as argv and echoes them back.
    // If the command were still run via shell:true, stdout would be plain
    // 'wired-marker' with no flags.
    const r = await runShellWithBoundedTail(
      'echo wired-marker',
      base({
        shell: { kind: 'pwsh', displayName: 'PowerShell 7 (pwsh)', exe: '/bin/echo' },
      }),
    );
    assert.equal(r.exitCode, 0);
    assert.ok(
      r.stdout.startsWith(
        '-NoLogo -NoProfile -NonInteractive -Command $__makaUtf8 = [System.Text.UTF8Encoding]::new($false)\n',
      ),
      `flags then PowerShell wrapper, got: ${r.stdout}`,
    );
    assert.ok(r.stdout.includes("GetEnvironmentVariable('__MAKA_RUNTIME_POWERSHELL_COMMAND')"));
    assert.doesNotMatch(r.stdout, /wired-marker/u, 'user syntax stays outside argv');
  });

  test('a native command exit code survives the PowerShell -Command path (requires pwsh)', async (t) => {
    // Without the wrapper, pwsh -Command maps any non-zero native exit code to
    // 1 (verified against real pwsh). node stands in for the native command.
    const pwsh = findPwsh();
    if (!pwsh) return t.skip('pwsh not installed');
    const r = await runShellWithBoundedTail(
      `& '${process.execPath}' -e 'process.exit(42)'`,
      base({ shell: { kind: 'pwsh', displayName: 'PowerShell 7 (pwsh)', exe: pwsh } }),
    );
    assert.equal(r.exitCode, 42);
  });

  test('deliberate boundary: earlier native exit code wins over a final cmdlet failure (requires pwsh)', async (t) => {
    // Plain pwsh -Command would exit 1 here (last statement is a cmdlet
    // failure). The wrapper cannot tell WHICH statement tripped $? , and the
    // only observable ($Error growth) would misreport the far more common
    // "cmdlet noise, then native command fails last" shape back to 1. So when
    // the final statement failed, the wrapper deliberately prefers the last
    // native exit code over the generic 1 — both are non-zero, stderr still
    // carries the cmdlet error. Pinned so a wrapper change surfaces here.
    const pwsh = findPwsh();
    if (!pwsh) return t.skip('pwsh not installed');
    const r = await runShellWithBoundedTail(
      `& '${process.execPath}' -e 'process.exit(42)'\nGet-Item ./maka-definitely-missing-file`,
      base({ shell: { kind: 'pwsh', displayName: 'PowerShell 7 (pwsh)', exe: pwsh } }),
    );
    assert.equal(r.exitCode, 42);
    assert.match(r.stderr, /maka-definitely-missing-file/);
  });

  test('emits every chunk live via emitOutput', async () => {
    const seen: Array<[string, string]> = [];
    await runShellWithBoundedTail(
      "printf 'aaa'; printf 'bbb' >&2",
      base({ emitOutput: (s: 'stdout' | 'stderr', c: string) => seen.push([s, c]) }),
    );
    assert.ok(seen.some(([s, c]) => s === 'stdout' && c.includes('aaa')));
    assert.ok(seen.some(([s, c]) => s === 'stderr' && c.includes('bbb')));
  });

  test('caps live emitOutput per stream with a single suppressed marker (result keeps full tail)', async () => {
    const seen: Array<[string, string]> = [];
    const r = await runShellWithBoundedTail(
      "printf 'HEAD\\n'; seq 1 2000; printf 'TAIL\\n'",
      base({
        maxLiveEmitChars: 20, // tiny cap so the stream trips it almost immediately
        emitOutput: (s: 'stdout' | 'stderr', c: string) => seen.push([s, c]),
      }),
    );
    assert.equal(r.exitCode, 0);
    const stdoutEmits = seen.filter(([s]) => s === 'stdout');
    const markers = stdoutEmits.filter(([, c]) => c.includes('live output suppressed'));
    assert.equal(markers.length, 1, 'exactly one suppressed marker, not one per chunk');
    const liveChars = stdoutEmits
      .filter(([, c]) => !c.includes('live output suppressed'))
      .reduce((n, [, c]) => n + c.length, 0);
    assert.ok(liveChars <= 20, `live emit bounded to cap, got ${liveChars}`);
    // The suppressed LIVE feed does not lose the result: the retained tail still
    // carries the real output (the last bytes the command produced).
    assert.ok(r.stdout.includes('TAIL'), 'retained tail keeps the command output');
  });

  test('killWindowsTree resolves false when taskkill cannot act on the target', async () => {
    // On non-Windows hosts `taskkill` is absent, so spawn emits an async 'error'
    // (ENOENT). Without the error listener that would be an unhandled 'error'
    // event and crash the process. Awaiting the real child outcome also pins the
    // ordering needed before a caller may fall back to killing only the root.
    assert.equal(await killWindowsTree(999_999), false);
  });
});
