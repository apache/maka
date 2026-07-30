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
  it('rejects an unknown route with the allowed set', async () => {
    const { code, stderr } = await runCli(['--route', 'not-a-route']);
    assert.equal(code, 2);
    assert.match(stderr, /--route must be one of: .*chat/);
  });

  it('rejects a typo even when another route is valid', async () => {
    const { code } = await runCli(['--route', 'chat', '--route', 'chatt']);
    assert.equal(code, 2);
  });

  it('rejects an unknown flag', async () => {
    const { code, stderr } = await runCli(['--not-a-flag']);
    assert.equal(code, 2);
    assert.match(stderr, /unknown arg/);
  });

  it('prints the route ids on --help and exits 0', async () => {
    const { code, stdout } = await runCli(['--help']);
    assert.equal(code, 0);
    assert.match(stdout, /Routes: chat, settings-general, settings-providers, mcp-hub, onboarding/);
  });
});
