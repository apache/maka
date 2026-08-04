import assert from 'node:assert/strict';
import test from 'node:test';
import { runWindowsSmoke } from './windows-smoke.mjs';

test('Windows smoke checks CLI entry points before the real Electron window', () => {
  const calls = [];
  runWindowsSmoke({
    platform: 'win32',
    existsSync: () => true,
    spawnSync(command, args, options) {
      calls.push([command, args, options]);
      return {
        status: 0,
        stdout: args.includes('--startup-only') ? '[real-window-smoke] report: report.md\n' : '',
        stderr: '',
      };
    },
  });
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[0][1].slice(-1), ['--version']);
  assert.deepEqual(calls[1][1].slice(-1), ['--help']);
  assert.ok(calls[2][1].includes('--startup-only'));
  assert.equal(calls[0][2].timeout, 15_000);
  assert.equal(calls[1][2].timeout, 15_000);
  assert.equal(calls[2][2].timeout, 45_000);
});

test('Windows smoke refuses to claim evidence on another platform', () => {
  assert.throws(() => runWindowsSmoke({ platform: 'linux' }), /must run on Windows/u);
});

test('Windows smoke rejects an Electron command that exits without exercising a window', () => {
  assert.throws(
    () =>
      runWindowsSmoke({
        platform: 'win32',
        existsSync: () => true,
        spawnSync: () => ({ status: 0, stdout: '', stderr: '' }),
      }),
    /without producing a report/u,
  );
});
