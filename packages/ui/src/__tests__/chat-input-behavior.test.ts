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
import { describe, it } from 'node:test';
import {
  createChatInputActionOwner,
  fileTransferContainsFiles,
  composerWireText,
  createTriggerSearchSource,
  isChatInputComposing,
} from '../chat-input-behavior.js';

describe('shared chat input behavior', () => {
  it('strips the token anchor from the wire text without touching real spaces', () => {
    // U+00A0 is what `insertToken` puts after a chip; the editor must keep it
    // (upstream's backspace-eats-the-token check keys on that codepoint) and
    // only the send path normalizes it. Asserted on codepoints because every
    // text matcher in the E2E layer folds U+00A0 into a plain space.
    assert.equal(composerWireText('a\u00a0b'), 'a b');
    assert.equal(composerWireText('@path\u00a0tail\u00a0more'), '@path tail more');
    assert.equal(composerWireText('a b'), 'a b');
    assert.equal(composerWireText('  \u00a0trim\u00a0  '), 'trim');
    assert.equal(composerWireText('line\none'), 'line\none');
  });

  it('answers the sync/async probe without searching, and abandons a superseded search', async () => {
    const calls: string[] = [];
    let settle: ((items: string[]) => void) | undefined;
    const source = createTriggerSearchSource<string>((query) => {
      calls.push(query);
      return new Promise<string[]>((resolve) => {
        settle = resolve;
      });
    });

    // `useTriggerMenu` probes with search('') before every keystroke's real
    // search and uses only `instanceof Promise`. It must not cost a lookup.
    const probe = source.search('');
    assert.ok(probe instanceof Promise);
    assert.deepEqual(calls, []);
    assert.deepEqual(await probe, []);

    // A real search always follows cancel().
    source.cancel();
    const first = source.search('a');
    assert.deepEqual(calls, ['a']);

    // The next query supersedes it. The older promise must never settle, or a
    // slow `a` landing after a fast `ab` would repopulate the menu behind the
    // query the user can see.
    source.cancel();
    const resolveFirst = settle!;
    const second = source.search('ab');
    assert.deepEqual(calls, ['a', 'ab']);
    resolveFirst(['stale']);
    settle!(['fresh']);

    // Drain the microtask queue first: racing against an already-resolved
    // promise would win on tick count alone and prove nothing.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const sentinel = Symbol('pending');
    const raced = await Promise.race([first, Promise.resolve(sentinel)]);
    assert.equal(raced, sentinel, 'superseded search must never settle');
    assert.deepEqual(await second, ['fresh']);
  });

  it('recognizes composition and file transfers across browser event shapes', () => {
    assert.equal(isChatInputComposing({ key: 'Enter', nativeEvent: { isComposing: true } }), true);
    assert.equal(isChatInputComposing({ key: 'Process', nativeEvent: {} }), true);
    assert.equal(isChatInputComposing({ nativeEvent: {} }, true), true);
    assert.equal(isChatInputComposing({ key: 'Enter', nativeEvent: {} }), false);
    // The bare-native shape: the composer's IME guard is a native listener, so
    // it hands this function a real KeyboardEvent with no `nativeEvent` of its
    // own. Reading `isComposing` off the event itself is the only reason this
    // helper takes both shapes.
    assert.equal(isChatInputComposing({ key: 'Enter', isComposing: true } as never), true);
    assert.equal(isChatInputComposing({ key: 'Enter', isComposing: false } as never), false);
    assert.equal(fileTransferContainsFiles(['text/plain', 'Files'], 0), true);
    assert.equal(fileTransferContainsFiles(['text/plain'], 1), true);
    assert.equal(fileTransferContainsFiles(['text/plain'], 0), false);
  });

  it('serializes async actions and releases only their owned pending state', async () => {
    const states: Array<string | null> = [];
    const owner = createChatInputActionOwner<string>((action) => states.push(action));
    let release!: () => void;
    const first = owner.run(
      'drop',
      () => new Promise<string>((resolve) => (release = () => resolve('done'))),
    );
    assert.equal(await owner.run('paste', async () => 'ignored'), undefined);
    release();
    assert.equal(await first, 'done');
    assert.equal(owner.pending, null);
    assert.deepEqual(states, ['drop', null]);
  });

  it('does not let late completion clear state after reset', async () => {
    const states: Array<string | null> = [];
    const owner = createChatInputActionOwner<string>((action) => states.push(action));
    let release!: () => void;
    const action = owner.run('drop', () => new Promise<void>((resolve) => (release = resolve)));
    owner.reset();
    release();
    await action;
    assert.deepEqual(states, ['drop']);
  });
});
