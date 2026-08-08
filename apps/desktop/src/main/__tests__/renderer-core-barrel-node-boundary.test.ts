/**
 * Executable regression guard for the renderer-facing `@maka/core` barrel.
 *
 * This test intentionally enforces a stronger structural invariant than the
 * current tree-shaking behavior: the renderer-facing root barrel must remain
 * loadable without evaluating any Node built-ins. The Electron renderer runs
 * in a browser-like environment where `node:*` modules cannot resolve (Vite
 * externalizes them; today they happen to be tree-shaken out of the renderer
 * graph, but nothing about that is guaranteed). This test spawns a child Node
 * process whose loader throws on every `node:*` import and then imports the
 * built barrel; the child exits non-zero the moment the barrel graph evaluates
 * Node-only code.
 *
 * This is the executable form of the source-regex contract that #1727 pruned
 * (the previous form asserted on `packages/core/src/index.ts` text; this one
 * asserts on the built artifact the renderer actually consumes).
 */

import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const DESKTOP_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

function runChild(
  args: string[],
  timeoutMs = 30_000,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: DESKTOP_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`child process timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

describe('renderer core barrel node boundary contract', () => {
  it('importing @maka/core evaluates no node:* module', async () => {
    const childPath = fileURLToPath(
      new URL('./fixtures/renderer-barrel-node-boundary-child.js', import.meta.url),
    );
    const { code, stdout, stderr } = await runChild([childPath]);
    assert.equal(code, 0, `child process failed:\n${stderr}`);
    assert.match(stdout, /barrel-ok/);
  });
});
