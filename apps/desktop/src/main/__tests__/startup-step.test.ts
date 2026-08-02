import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { startupStep, whileAwaitingPerson } from '../startup-step.js';

describe('startup step', () => {
  test('says nothing when the step comes back', async () => {
    const said: string[] = [];
    const value = await startupStep('quick thing', Promise.resolve('done'), {
      intervalMs: 1,
      report: (message) => said.push(message),
    });

    assert.equal(value, 'done');
    assert.deepEqual(said, []);
    // And keeps saying nothing. Asserting only at the await would stay green
    // if `clearInterval` moved out of `finally` onto the reject path.
    await new Promise((resolve) => setTimeout(resolve, 10));
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

  test('stays quiet while a person is the one being waited on', async () => {
    // A modal waiting for an answer is not a hang, and reporting one every
    // three seconds tells somebody reading a dialog that the app is stuck.
    const said: string[] = [];
    let answer: (value: string) => void = () => {};
    const dialog = new Promise<string>((resolve) => {
      answer = resolve;
    });

    const pending = startupStep('storage root', whileAwaitingPerson(dialog), {
      intervalMs: 1,
      report: (message) => said.push(message),
    });
    await new Promise((resolve) => setTimeout(resolve, 15));
    assert.deepEqual(said, [], 'the wait belongs to the person, not to a stuck step');
    answer('repair');

    assert.equal(await pending, 'repair');
  });

  test('still names a step that hangs before the person is asked', async () => {
    // Pausing the whole step would hide the failure this exists to catch: disk
    // I/O that never returns, before any dialog opens.
    const said: string[] = [];
    let open: (value: string) => void = () => {};
    const readingDisk = new Promise<string>((resolve) => {
      open = resolve;
    });

    const pending = startupStep(
      'storage root',
      readingDisk.then((value) => whileAwaitingPerson(Promise.resolve(value))),
      { intervalMs: 1, report: (message) => said.push(message) },
    );
    while (said.length < 1) await new Promise((resolve) => setTimeout(resolve, 2));
    open('read');

    assert.equal(await pending, 'read');
    assert.deepEqual(new Set(said), new Set(['[startup] still waiting on storage root']));
  });
});
