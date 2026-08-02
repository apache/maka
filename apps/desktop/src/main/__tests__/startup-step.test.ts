import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { startupStep } from '../startup-step.js';

describe('startup step', () => {
  test('says nothing when the step comes back', async () => {
    const said: string[] = [];
    const value = await startupStep('quick thing', Promise.resolve('done'), {
      intervalMs: 1,
      report: (message) => said.push(message),
    });

    assert.equal(value, 'done');
    assert.deepEqual(said, []);
  });

  test('names the step that has not come back, and keeps naming it', async () => {
    const said: string[] = [];
    let settle: (value: string) => void = () => {};
    const work = new Promise<string>((resolve) => {
      settle = resolve;
    });

    const pending = startupStep('storage root', work, {
      intervalMs: 1,
      report: (message) => said.push(message),
    });
    // Two reports, so a launch that stays stuck keeps saying so rather than
    // mentioning it once and going quiet again.
    while (said.length < 2) await new Promise((resolve) => setTimeout(resolve, 2));
    settle('opened');

    assert.equal(await pending, 'opened');
    assert.deepEqual(new Set(said), new Set(['[startup] still waiting on storage root']));
  });

  test('stops reporting once the step fails, and lets the failure through', async () => {
    const said: string[] = [];
    const failure = new Error('root is not a directory');

    await assert.rejects(
      () =>
        startupStep('storage root', Promise.reject(failure), {
          intervalMs: 1,
          report: (message) => said.push(message),
        }),
      failure,
    );

    const afterSettling = said.length;
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(said.length, afterSettling);
  });
});
