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
import { act, createRef, useState } from 'react';
import type { ExecutorSelection } from '@maka/core/executor-catalog';
import { Composer, type ComposerHandle } from '../composer.js';
import { ComposerModelPicker } from '../composer-model-picker.js';
import { highestExecutorModelVariant } from '../executor-model-presentation.js';
import { LocaleProvider } from '../locale-context.js';
import { installTranscriptDom } from './transcript-test-dom.js';
import { deriveComposerModelSwitchAvailability } from '../composer-helpers.js';
import { actions, catalog, choices, session } from './composer-model-picker-fixture.js';

test('new tasks can recover another Agent without changing their selection', async () => {
  const dom = installTranscriptDom();
  const setup: string[] = [];
  let retries = 0;
  let selectionWrites = 0;
  try {
    for (const readiness of ['authentication_required', 'unavailable'] as const) {
      for (const selected of [false, true]) {
        await dom.render(<LocaleProvider locale="en"><ComposerModelPicker label="Native" choices={choices}
          executor={{ catalog: [{ ...catalog[0]!, readiness }, { ...catalog[0]!, id: 'ready', displayName: 'Ready Agent' }],
            selection: selected ? { executorId: 'ready', configuration: { model: 'opaque-high' } } : undefined,
            onSelect() { selectionWrites++; },
            onSetup: id => { setup.push(id!); }, onRetry: () => { retries++; }, onNewTask() {} }}
        /></LocaleProvider>);
        const { click, trigger } = actions(dom);
        await click([...dom.document.querySelectorAll('button')].find(el => el.textContent === (readiness === 'unavailable' ? 'Retry' : 'Go to sign in')));
        assert.equal(trigger()?.textContent, selected ? 'Ready Agent · Family' : 'Native');
      }
    }
    assert.deepEqual(setup, ['agent', 'agent']);
    assert.equal(retries, 2);
    assert.equal(selectionWrites, 0);
  } finally { await dom.cleanup(); }
});

test('recovery opens the grouped Selector and commits the exact connection identity', async () => {
  const dom = installTranscriptDom();
  dom.window.getSelection = () => null;
  const ref = createRef<ComposerHandle>();
  const writes: unknown[] = [];
  try {
    await dom.render(<LocaleProvider locale="en"><Composer ref={ref}
      activeSession={session('a')} modelChoices={choices} activeModelLabel="GPT-6.1 Sol"
      onModelChange={target => { writes.push(target); }} onSend={() => undefined} onStop={() => undefined}
    /></LocaleProvider>);
    const { click, trigger } = actions(dom);
    assert.equal(trigger()?.textContent, 'GPT-6.1 Sol');
    assert.equal(dom.document.querySelector('[role="menuitemradio"]'), null);
    await act(async () => { ref.current?.openModelPicker(); });
    assert.equal(trigger()?.getAttribute('aria-expanded'), 'true');
    const secondGroup = dom.document.querySelector('[role="group"][aria-label="second"]');
    assert.ok(secondGroup);
    await click(secondGroup.querySelector('[role="option"]'));
    assert.deepEqual(writes, [{ llmConnectionId: 'second', llmConnectionSlug: 'second', model: 'gpt-6.1-sol' }]);
    assert.doesNotMatch(trigger()?.textContent ?? '', /1M/);
  } finally { await dom.cleanup(); }
});

test('the cache notice is acknowledged without switching or losing the open model list', async () => {
  const dom = installTranscriptDom();
  let writes = 0;
  try {
    await dom.render(<LocaleProvider locale="en"><ComposerModelPicker label="GPT-6.1 Sol"
      choices={choices} value="first:first:gpt-6.1-sol" sessionId="a" hasConversationHistory
      onNativeChange={() => { writes++; }}
    /></LocaleProvider>);
    const { click, trigger } = actions(dom);
    await click(trigger());
    const notice = [...dom.document.querySelectorAll('[role="option"]')].find(el => el.textContent?.includes('prompt cache'));
    await click(notice);
    assert.equal(writes, 0);
    assert.equal(trigger()?.getAttribute('aria-expanded'), 'true');
    assert.equal([...dom.document.querySelectorAll('[role="option"]')].some(el => el.textContent?.includes('prompt cache')), false);
  } finally { await dom.cleanup(); }
});

test('native effort defaults clear the override and pending state stays scoped to its Session', async () => {
  const dom = installTranscriptDom();
  const picked: unknown[] = [];
  let finish!: () => void;
  const render = (id: string) => dom.render(<LocaleProvider locale="en"><Composer
    activeSession={session(id)} modelChoices={choices} activeModelLabel="GPT-6.1 Sol"
    activeThinkingLevels={['low', 'high']} activeThinkingLevel="high"
    onThinkingLevelChange={level => { picked.push(level); return new Promise<void>(resolve => { finish = resolve; }); }}
    onModelChange={() => undefined} onSend={() => undefined} onStop={() => undefined}
  /></LocaleProvider>);
  try {
    await render('a');
    const { click, option, trigger } = actions(dom);
    await click(trigger('.maka-thinking-level-selector'));
    await click(option('Default'));
    assert.deepEqual(picked, [undefined]);
    assert.equal(trigger('.maka-thinking-level-selector')?.textContent, 'Default');
    await render('b');
    assert.equal(trigger('.maka-thinking-level-selector')?.textContent, 'High');
    await act(async () => { finish(); });
    assert.equal(trigger('.maka-thinking-level-selector')?.textContent, 'High');
  } finally { await dom.cleanup(); }
});

test('external model families preserve opaque IDs, reset model-bound modes and report pending admission', async () => {
  const dom = installTranscriptDom();
  const writes: ExecutorSelection[] = [];
  const pending: boolean[] = [];
  let finish!: () => void;
  function Frame() {
    const [selected, setSelected] = useState<ExecutorSelection>({ executorId: 'agent', configuration: { model: 'opaque-high', mode: 'plan' } });
    return <LocaleProvider locale="en"><ComposerModelPicker label="Native" choices={choices}
      executor={{ catalog, selection: selected, onSelect: async next => {
        assert.ok(next); writes.push(next);
        await new Promise<void>(resolve => { finish = resolve; });
        setSelected(next);
      }, onSetup() {}, onRetry() {}, onNewTask() {} }}
      onNativeChange={() => undefined} onPendingChange={value => pending.push(value)}
    /></LocaleProvider>;
  }
  try {
    await dom.render(<Frame />);
    const { click, option, trigger } = actions(dom);
    await click(trigger('.maka-thinking-level-selector'));
    await click(option('Low'));
    assert.deepEqual(writes, [{ executorId: 'agent', configuration: { model: 'opaque-low' } }]);
    assert.equal(pending.at(-1), true);
    await act(async () => { finish(); });
    assert.equal(pending.at(-1), false);
    assert.equal(trigger()?.textContent, 'Agent · Family');
    await click(trigger());
    await click(option('Other'));
    assert.deepEqual(writes.at(-1), { executorId: 'agent', configuration: { model: 'other' } });
    await dom.render(<div />);
    assert.equal(pending.at(-1), false);
    await act(async () => { finish(); });
  } finally { await dom.cleanup(); }
});

test('fixed external sessions show only their executor and failed writes retain the confirmed model', async () => {
  const dom = installTranscriptDom();
  try {
    await dom.render(<LocaleProvider locale="en"><ComposerModelPicker label="Native" choices={choices}
      executor={{ catalog: [...catalog, { ...catalog[0]!, id: 'other', displayName: 'Other Agent', readiness: 'authentication_required' }], selection: { executorId: 'agent', configuration: { model: 'opaque-high' } }, fixed: true,
        onSelect: async () => { throw Error('offline'); }, onSetup() {}, onRetry() {}, onNewTask() {} }}
    /></LocaleProvider>);
    const { click, option, trigger } = actions(dom);
    await click(trigger());
    assert.deepEqual([...dom.document.querySelectorAll('[role="group"]')].map(element => element.getAttribute('aria-label')), ['Agent']);
    assert.equal([...dom.document.querySelectorAll('button')].some(element => element.textContent === 'Go to sign in'), false);
    await click(option('Other'));
    assert.equal(trigger()?.textContent, 'Family');
    assert.match(dom.document.querySelector('[role="status"]')?.textContent ?? '', /failed/);
    await click(trigger());
    assert.ok(option('Other'));
  } finally { await dom.cleanup(); }
});

test('unavailable agents cannot commit and use the existing sign-in or restore actions', async () => {
  const dom = installTranscriptDom();
  const setup: string[] = [];
  let restored = 0;
  try {
    for (const readiness of ['authentication_required', 'restorable', 'restoring'] as const) {
      await dom.render(<LocaleProvider locale="en"><ComposerModelPicker label="Native" choices={choices}
        executor={{ catalog: [{ ...catalog[0]!, readiness }], selection: { executorId: 'agent', configuration: { model: 'opaque-high' } }, fixed: true,
          onSelect() { assert.fail('unavailable model must never commit'); },
          onSetup: id => { setup.push(id!); }, onRetry() {}, onNewTask() {}, onRestore: () => { restored++; } }}
      /></LocaleProvider>);
      const { click } = actions(dom);
      const buttons = [...dom.document.querySelectorAll('button')];
      if (readiness === 'authentication_required') await click(buttons.find(el => el.textContent === 'Go to sign in'));
      if (readiness === 'restorable') await click(buttons.find(el => el.textContent === 'Restore Session'));
      if (readiness === 'restoring') assert.equal(buttons.some(el => el.textContent === 'Restore Session'), false);
    }
    assert.deepEqual(setup, ['agent']);
    assert.equal(restored, 1);
  } finally { await dom.cleanup(); }
});

test('Composer blocks sending while an external configuration write is unsettled', async () => {
  const dom = installTranscriptDom();
  dom.window.getSelection = () => null;
  dom.document.getSelection = () => null;
  const ref = createRef<ComposerHandle>();
  let finish!: () => void;
  try {
    await dom.render(<LocaleProvider locale="en"><Composer ref={ref}
      activeSession={session('external')} modelChoices={choices}
      executorPicker={{ catalog, fixed: true, selection: { executorId: 'agent', configuration: { model: 'opaque-high' } },
        onSelect: () => new Promise<void>(resolve => { finish = resolve; }), onSetup() {}, onRetry() {}, onNewTask() {} }}
      onSend={() => undefined} onStop={() => undefined}
    /></LocaleProvider>);
    await act(async () => { ref.current?.setText('Continue the task'); });
    const send = () => dom.document.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!;
    assert.equal(send().disabled, false);
    const { click, option, trigger } = actions(dom);
    await click(trigger());
    await click(option('Other'));
    assert.equal(send().getAttribute('aria-disabled'), 'true');
    await act(async () => { finish(); });
    assert.notEqual(send().getAttribute('aria-disabled'), 'true');
  } finally { await dom.cleanup(); }
});

test('model switching availability retains its priority and opaque family levels keep catalog order independent', () => {
  assert.deepEqual(deriveComposerModelSwitchAvailability({ streaming: true, sessionStatus: 'running', pending: true }), { available: false, pending: true, reason: 'streaming' });
  assert.deepEqual(deriveComposerModelSwitchAvailability({ sessionStatus: 'running', pending: true }), { available: false, pending: true, reason: 'running' });
  assert.deepEqual(deriveComposerModelSwitchAvailability({ sessionStatus: 'waiting_for_user' }), { available: false, pending: false, reason: 'permission' });
  assert.equal(deriveComposerModelSwitchAvailability({}).available, true);
  assert.equal(highestExecutorModelVariant(catalog[0]!.modelGroups![0]!), 'opaque-high');
});
