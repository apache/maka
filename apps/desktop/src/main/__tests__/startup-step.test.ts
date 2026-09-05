/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

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
    // mentioning it once and going quiet again. Bounded, because a regression
    // that reports once — swapping setInterval for setTimeout is the obvious
    // one — would otherwise hang the suite until the CI job times out, with no
    // failing assertion to say which test stalled.
    const deadline = Date.now() + 2_000;
    while (said.length < 2 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    assert.ok(said.length >= 2, 'the step should have been named twice while it was still pending');
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

  test('names a dialog that never appears, exactly once', async () => {
    // The failure this has to catch: `dialog.showMessageBox` is called before
    // any window exists, the modal never attaches, and the promise never
    // settles. Nobody is reading a dialog, because there is no dialog. Going
    // silent for the whole span would print nothing at all here — which is the
    // silence this file was written to end.
    //
    // Once, not every three seconds: a person who does have a dialog on screen
    // is not told repeatedly that the app is stuck.
    const said: string[] = [];
    let answer: (value: string) => void = () => {};
    const dialog = new Promise<string>((resolve) => {
      answer = resolve;
    });

    const pending = startupStep('storage root', whileAwaitingPerson(dialog), {
      intervalMs: 1,
      report: (message) => said.push(message),
    });
    // Bounded rather than spun on: a version that says nothing has to fail on
    // the assertion below, not by hanging the suite until the runner times out.
    const deadline = Date.now() + 2_000;
    while (said.length < 1 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    await new Promise((resolve) => setTimeout(resolve, 20));

    try {
      assert.deepEqual(said, [
        '[startup] storage root is waiting for an answer; if no dialog is on screen, none opened',
      ]);
    } finally {
      // Answered even when the assertion fails, so the step settles and its
      // reporting timer is cleared rather than left running for the suite.
      answer('repair');
    }

    assert.equal(await pending, 'repair');
  });

  test('does not call a person reading a dialog a hang', async () => {
    // The wait belongs to the person, so it is never reported as a step that
    // has not come back — the line that would send somebody hunting a bug.
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
    assert.ok(
      !said.includes('[startup] still waiting on storage root'),
      'a person answering a question is not a stuck step',
    );
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
    // Bounded for the same reason as the first test: a regression that never
    // reports should fail here, not stall the runner with nothing to read.
    const deadline = Date.now() + 2_000;
    while (said.length < 1 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    assert.ok(said.length >= 1, 'a step stuck before the person is asked should still be named');
    open('read');

    assert.equal(await pending, 'read');
    assert.deepEqual(new Set(said), new Set(['[startup] still waiting on storage root']));
  });
});
