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
import test from 'node:test';
import { presenter } from './terminal-presenter-harness.mjs';
import { fixture } from './terminal-transcript-harness.mjs';

const plain = (value) => JSON.parse(JSON.stringify(value));
const descriptor = { title: { fallback: 'App' }, context: 'application' };
const read = { kind: 'read', route: { item: 'original' }, locale: 'zh-TW' };

test('private backend registration rejects inline handlers and captures exact metadata', async () => {
  let original;
  const f = await fixture({}, async ({ tui, remote }) => {
    await assert.rejects(tui.app('old', { read() {}, submit() {} }, descriptor), /entry.*backend/);
    for (const kind of ['method', 'stream']) {
      await assert.rejects(
        remote[kind](`legacy-${kind}`, () => null, {
          terminalView: { ...descriptor, version: 7 },
        }),
        /terminalView; use tui\.app/,
      );
    }
    const activity = await tui.transcriptResource('activity');
    await tui.app(
      'app',
      {
        entry: 'app-ui.mjs',
        resources: [activity.resource],
        backend(input, cx) {
          original = { input: plain(input), caller: cx.caller, text: cx.t('en', 'cn', 'tw') };
          return { model: true };
        },
      },
      descriptor,
      { access: 'host_paths' },
    );
    return activity;
  });
  const definition = f.registrations.find(({ name }) => name === 'app');
  assert.equal(definition.kind, 'terminal_app');
  assert.equal(definition.entry, 'app-ui.mjs');
  assert.equal(definition.terminalView.version, 7);
  assert.equal(definition.access, 'host_paths');
  assert.deepEqual(plain(definition.resources), [plain(f.store.resource)]);
  assert.equal(f.registrations.filter(({ name }) => name === 'app').length, 1);
  assert.equal(
    f.registrations.some(({ name }) => name.startsWith('legacy-')),
    false,
  );
  assert.equal((await f.invoke('app', read)).kind, 'value');
  assert.deepEqual(original.input, read);
  assert.equal(original.caller.documentId, 'doc');
  assert.equal(original.text, 'tw');
  await f.runtime.dispose();
});

test('one factory supplies only shared pure builders and invocation-scoped backend', async () => {
  let factories = 0;
  let retained;
  const received = [];
  const p = presenter(
    ({ tui, ...rest }) => {
      factories++;
      assert.deepEqual(Object.keys(rest), []);
      for (const name of ['app', 'changes', 'transcriptResource', 'storage', 'run']) {
        assert.equal(tui[name], undefined);
      }
      return {
        async read(route, cx) {
          assert.deepEqual(Object.keys(cx).sort(), ['backend', 'locale', 'signal', 't']);
          assert.equal(cx.t('en', 'cn', 'tw'), 'tw');
          route.item = 'changed by UI';
          assert.throws(() => cx.backend({ kind: 'submit' }), /arguments/);
          const model = await cx.backend();
          assert.throws(() => cx.backend(), /once/);
          retained = cx;
          return { title: model.title, revision: '1', root: tui.text('body', model.text) };
        },
        submit: (_submission, cx) => cx.backend(),
        recover: (_route, cx) => cx.backend(),
      };
    },
    async (input, caller) => {
      received.push({ input, caller });
      return input.kind === 'read'
        ? { title: 'A', text: '中文' }
        : { kind: 'applied', route: null };
    },
  );
  assert.equal(factories, 0);
  const caller = { document: 'original' };
  assert.equal((await p.invoke(read, caller)).view.version, 7);
  assert.deepEqual(received[0], { input: read, caller });
  assert.throws(() => retained.backend(), /retired/);
  assert.equal(retained.signal.aborted, true);
  const submit = {
    kind: 'submit',
    route: null,
    revision: '1',
    fields: {},
    action: 'save',
    grant: null,
    locale: 'en',
  };
  assert.deepEqual(await p.invoke(submit, caller), { kind: 'applied', route: null });
  await p.invoke({ kind: 'recover', route: { receipt: 'one' }, locale: 'en' }, caller);
  assert.equal(received[1].input.kind, 'submit');
  assert.equal(received[2].input.kind, 'recover');
  assert.equal(factories, 1);
});

test('cancel wakes the current signal and blocks backend after page retirement', async () => {
  let entered;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  let calls = 0;
  const p = presenter(
    ({ tui }) => ({
      async read(_route, cx) {
        entered();
        await cx.signal.wait();
        assert.equal(cx.signal.aborted, true);
        assert.throws(() => cx.backend(), /cancelled|retired/);
        cx.signal.throwIfAborted();
        return { title: 'Unused', revision: '1', root: tui.rule('body') };
      },
      submit: (_input, cx) => cx.backend(),
    }),
    () => {
      calls++;
    },
  );
  const pending = p.invoke(read);
  await started;
  p.cancel();
  await assert.rejects(pending, /cancelled|retired/);
  await assert.rejects(p.invoke(read), /closed|retired/);
  assert.equal(calls, 0);
});

test('the Module cancel hook addresses the exact invocation signal', async () => {
  let entered;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  let calls = 0;
  const p = presenter(
    ({ tui }) => ({
      async read(route, cx) {
        if (route?.wait) {
          entered();
          await cx.signal.wait();
          assert.throws(() => cx.backend(), /cancelled/);
          cx.signal.throwIfAborted();
        }
        await cx.backend();
        return { title: 'Active', revision: '1', root: tui.rule('body') };
      },
      submit: (_input, cx) => cx.backend(),
    }),
    () => {
      calls++;
      return null;
    },
  );
  const pending = p.invoke({ ...read, route: { wait: true } });
  await started;
  p.runtime.cancel('call-1');
  await assert.rejects(pending, /cancelled/);
  assert.equal((await p.invoke(read)).kind, 'view');
  assert.equal(calls, 1);
});
