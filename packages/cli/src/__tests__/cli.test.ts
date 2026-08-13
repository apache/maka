import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { describe, test } from 'node:test';
import { parseMakaCliArgs } from '../cli.js';

describe('Maka CLI args', () => {
  test('selects a Runtime Host and Project for TUI startup', () => {
    assert.deepEqual(parseMakaCliArgs(['--host', 'office', '--project', 'project-1'], '0.1.0'), {
      kind: 'tui',
      hostProfileId: 'office',
      projectId: 'project-1',
    });
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
