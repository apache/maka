import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

test('reports matching allowed and denied observations', () => {
  const root = mkdtempSync(join(tmpdir(), 'maka-w0-probe-'));
  try {
    const allowedRead = join(root, 'read.txt');
    const allowedWrite = join(root, 'write.txt');
    const manifestPath = join(root, 'manifest.json');
    writeFileSync(allowedRead, 'ok');
    writeFileSync(
      manifestPath,
      JSON.stringify({
        allowedRead,
        deniedRead: join(root, 'missing-read.txt'),
        allowedWrite,
        deniedWrite: join(root, 'missing-parent', 'write.txt'),
        network: { host: '127.0.0.1', port: 9, expected: 'denied', timeoutMs: 500 },
        forbiddenEnvironment: ['MAKA_W0_TEST_SECRET'],
      }),
    );

    const result = spawnSync(process.execPath, ['experiments/windows-sandbox/probe.mjs', '--manifest', manifestPath], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: { ...process.env, MAKA_W0_TEST_SECRET: undefined },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    assert.equal(report.passed, true);
    assert.deepEqual(
      report.observations.map(({ operation, expected, actual }) => ({ operation, expected, actual })),
      [
        { operation: 'read_allowed', expected: 'allowed', actual: 'allowed' },
        { operation: 'read_denied', expected: 'denied', actual: 'denied' },
        { operation: 'write_allowed', expected: 'allowed', actual: 'allowed' },
        { operation: 'write_denied', expected: 'denied', actual: 'denied' },
        { operation: 'network_connect', expected: 'denied', actual: 'denied' },
        { operation: 'environment:MAKA_W0_TEST_SECRET', expected: 'absent', actual: 'absent' },
        { operation: 'descendant_launch', expected: 'managed', actual: 'managed' },
      ],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test('returns failure when an expected denial is actually allowed', () => {
  const root = mkdtempSync(join(tmpdir(), 'maka-w0-probe-failure-'));
  try {
    const readable = join(root, 'readable.txt');
    const manifestPath = join(root, 'manifest.json');
    mkdirSync(join(root, 'workspace'));
    writeFileSync(readable, 'not denied');
    writeFileSync(manifestPath, JSON.stringify({ deniedRead: readable }));

    const result = spawnSync(process.execPath, ['experiments/windows-sandbox/probe.mjs', '--manifest', manifestPath], {
      cwd: process.cwd(),
      encoding: 'utf8',
    });
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stdout).passed, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
