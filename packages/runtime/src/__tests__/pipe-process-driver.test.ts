import assert from 'node:assert/strict';
import test from 'node:test';

import { PipeProcessDriver, type PipeProcessExit } from '../pipe-process-driver.js';

test('reports a partial stdin delivery failure before the child exit', async () => {
  const failures: Error[] = [];
  const events: string[] = [];
  let resolveExit!: (exit: PipeProcessExit) => void;
  const exited = new Promise<PipeProcessExit>((resolve) => {
    resolveExit = resolve;
  });
  const driver = new PipeProcessDriver({
    plan: {
      file: process.execPath,
      args: [
        '-e',
        [
          "const fs = require('node:fs');",
          'fs.closeSync(0);',
          'setTimeout(() => process.exit(0), 50);',
        ].join(' '),
      ],
      useShellOption: false,
      stdin: 'x'.repeat(8 * 1024 * 1024),
    },
    cwd: process.cwd(),
    outputDrainMs: 1_000,
    onData() {},
    onRootExit() {},
    onFailure(error) {
      events.push('failure');
      failures.push(error);
    },
    onExit(exit) {
      events.push('exit');
      resolveExit(exit);
    },
  });

  try {
    driver.writeInputs();
    await driver.ready;
    const exit = await exited;
    assert.equal(exit.exitCode, 0);
    assert.equal(failures.length, 1);
    assert.match(String((failures[0] as NodeJS.ErrnoException).code), /EPIPE|ERR_STREAM_DESTROYED/);
    assert.deepEqual(events, ['failure', 'exit']);
  } finally {
    driver.dispose();
  }
});
