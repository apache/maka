// CLI contract for the hit-test harness, driven as a real subprocess so the
// exit codes under test are the ones a shell actually sees. Every case here
// fails (or prints help) during argument parsing, before any window launches.
//
// The case that earns this file: `--route chat --route chatt` used to drop
// the typo, probe one route, and exit 0 as "1 route(s) clean" — a coverage
// tool silently shrinking the requested coverage.
import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { HitTestArgumentError, parseHitTestArgs } from './check-hit-test.mjs';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'check-hit-test.mjs');

function runCli(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

describe('check-hit-test CLI', () => {
  it('parses repeated routes without silently dropping a typo', () => {
    assert.deepEqual(parseHitTestArgs(['--route', 'chat', '--route', 'settings-general']), {
      routes: ['chat', 'settings-general'],
    });
    assert.throws(
      () => parseHitTestArgs(['--route', 'chat', '--route', 'chatt']),
      (error) =>
        error instanceof HitTestArgumentError && /must be one of: .*chat/.test(error.message),
    );
  });

  it('rejects unknown flags without starting the renderer harness', () => {
    assert.throws(() => parseHitTestArgs(['--not-a-flag']), /unknown arg/);
  });

  it('preserves the real process help and exit-code contract', async () => {
    const { code, stdout } = await runCli(['--help']);
    assert.equal(code, 0);
    assert.match(stdout, /Routes: chat, settings-general, settings-providers, mcp-hub, onboarding/);
  });
});
