import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { describe, test } from 'node:test';
import { resolveMakaCliExitCode } from '../cli.js';

describe('Maka CLI args', () => {
  test('preserves an established process exit code', () => {
    assert.equal(resolveMakaCliExitCode(2, undefined), 2);
    assert.equal(resolveMakaCliExitCode(0, 143), 143);
  });

  test('establishes the fatal exit before reporting can throw', async () => {
    const cliUrl = new URL('../cli.js', import.meta.url).href;
    const childSource = `
      import { handleMakaCliProcessExit } from ${JSON.stringify(cliUrl)};
      try {
        handleMakaCliProcessExit(1, new Error('fatal'), () => { throw new Error('writer failed'); });
      } catch {}
    `;
    const child = spawn(process.execPath, ['--input-type=module', '-e', childSource], {
      stdio: 'ignore',
    });
    const [code, signal] = (await once(child, 'exit')) as [number | null, NodeJS.Signals | null];

    assert.equal(signal, null);
    assert.equal(code, 1);
  });
});
