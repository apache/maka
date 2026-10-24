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
import { ToastProvider } from '../toast.js';
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
        assert.equal(trigger()?.textContent, selected ? 'Family' : 'Native');
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
    assert.equal(trigger()?.textContent, 'Family');
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

test('existing Sessions keep authentication and history recovery actions in the Composer', async () => {
  const dom = installTranscriptDom();
  const setup: string[] = [];
  let newTasks = 0;
  try {
    for (const readiness of ['authentication_required', 'history_only', 'history_gap'] as const) {
      await dom.render(<LocaleProvider locale="en"><Composer activeSession={session('external')}
        executorPicker={{ catalog: [{ ...catalog[0]!, readiness }], fixed: true,
          selection: { executorId: 'agent', configuration: { model: 'opaque-high' } },
          onSelect() { assert.fail('unavailable model must never commit'); },
          onSetup: id => { setup.push(id!); }, onRetry() {}, onNewTask() { newTasks++; } }}
        onSend={() => undefined} onStop={() => undefined}
      /></LocaleProvider>);
      const recovery = dom.document.querySelector('.maka-executor-recovery');
      assert.ok(recovery);
      await actions(dom).click(recovery.querySelector('button'));
    }
    assert.deepEqual(setup, ['agent']);
    assert.equal(newTasks, 2);
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

test('external session recovery preserves the draft and releases pending state after failure', async () => {
  const dom = installTranscriptDom();
  dom.window.getSelection = () => null;
  dom.document.getSelection = () => null;
  const ref = createRef<ComposerHandle>();
  let rejectRestore!: (error: Error) => void;
  let restores = 0;
  try {
    await dom.render(<LocaleProvider locale="en"><Composer ref={ref}
      activeSession={session('external')} sendBlocked
      executorPicker={{ catalog: [{ ...catalog[0]!, readiness: 'restore_failed' }], fixed: true,
        selection: { executorId: 'agent', configuration: { model: 'opaque-high' } },
        onRestore: () => { restores++; return new Promise<void>((_resolve, reject) => { rejectRestore = reject; }); },
        onSelect() {}, onSetup() {}, onRetry() {}, onNewTask() {} }}
      onSend={() => undefined} onStop={() => undefined}
    /></LocaleProvider>);
    await act(async () => { ref.current?.setText('Keep this draft'); });
    const { click } = actions(dom);
    const restoreButton = () => [...dom.document.querySelectorAll('button')].find(el => el.textContent === 'Restore Session')!;
    await click(restoreButton());
    assert.equal(restoreButton().disabled, true);
    await click(restoreButton());
    assert.equal(restores, 1);
    assert.match(dom.document.querySelector('.maka-executor-recovery')!.textContent!, /Restoring/);
    await act(async () => { rejectRestore(new Error('Agent offline')); });
    assert.match(dom.document.querySelector('.maka-executor-recovery')!.textContent!, /Restoration failed/);
    assert.equal(restoreButton().disabled, false);
    assert.equal(ref.current?.getText(), 'Keep this draft');
    assert.equal(dom.document.querySelector('button[aria-label="Send"]')!.getAttribute('aria-disabled'), 'true');
  } finally { await dom.cleanup(); }
});

test('typing never restores; automatic recovery submits once and preserves a refused draft', async () => {
  const dom = installTranscriptDom();
  dom.window.getSelection = () => null;
  dom.document.getSelection = () => null;
  const setAttribute = dom.window.Element.prototype.setAttribute;
  dom.window.Element.prototype.setAttribute = function normalized(name: string, value: string) {
    return setAttribute.call(this, name === 'contentEditable' ? 'contenteditable' : name, value);
  };
  const ref = createRef<ComposerHandle>();
  let restores = 0;
  const sent: string[] = [];
  let finish!: (sent: boolean) => void;
  try {
    await dom.render(<LocaleProvider locale="en"><Composer ref={ref}
      activeSession={session('external')}
      executorPicker={{ catalog: [{ ...catalog[0]!, readiness: 'restorable' }], fixed: true,
        selection: { executorId: 'agent', configuration: { model: 'opaque-high' } },
        onRestore() { restores++; }, onSelect() { assert.fail('typing must not configure the Agent'); }, onSetup() {}, onRetry() {}, onNewTask() {} }}
      onSend={text => { sent.push(text); return new Promise<boolean>(resolve => { finish = resolve; }); }} onStop={() => undefined}
    /></LocaleProvider>);
    const editor = dom.document.querySelector<HTMLElement>('[contenteditable="true"]')!;
    await act(async () => { editor.focus(); });
    assert.equal(restores, 0);
    await act(async () => { editor.textContent = ' '; editor.dispatchEvent(new dom.window.Event('input', { bubbles: true })); });
    assert.equal(restores, 0);
    await act(async () => { editor.textContent = 'Continue this task'; editor.dispatchEvent(new dom.window.Event('input', { bubbles: true })); });
    assert.equal(restores, 0);
    assert.equal(ref.current?.getText(), 'Continue this task');
    assert.equal(dom.document.querySelector('.maka-executor-recovery'), null);
    const submit = () => dom.document.querySelector('form')!.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
    await act(async () => { submit(); submit(); });
    assert.deepEqual(sent, ['Continue this task']);
    assert.equal(restores, 0, 'sending delegates recovery to the Host');
    await act(async () => { finish(false); });
    assert.equal(ref.current?.getText(), 'Continue this task');
    await act(async () => { submit(); });
    await act(async () => { finish(true); });
    assert.equal(ref.current?.getText(), '');
  } finally { await dom.cleanup(); dom.window.Element.prototype.setAttribute = setAttribute; }
});

test('agent loading stays in its section and failed refresh keeps the selected agent refresh button', async () => {
  const dom = installTranscriptDom();
  const retried: Array<string | undefined> = [];
  try {
    for (const selection of [undefined, { executorId: 'ready', configuration: { model: 'opaque-high' } }]) {
      await dom.render(<LocaleProvider locale="en"><ToastProvider><ComposerModelPicker label="Native" choices={choices}
        executor={{ catalog: [{ ...catalog[0]!, readiness: 'unavailable', models: [] }, { ...catalog[0]!, id: 'ready', displayName: 'Ready Agent', refreshFailed: true }],
          selection, loading: true, loadingIds: ['agent'],
          onSelect() {}, onSetup() {}, onRetry: id => { retried.push(id); }, onNewTask() {} }}
      /></ToastProvider></LocaleProvider>);
      const { click, trigger } = actions(dom);
      assert.notEqual(trigger()?.getAttribute('aria-busy'), 'true', 'another agent never makes the current model busy');
      assert.equal(dom.document.querySelector('.maka-executor-notice'), null);
      assert.equal([...dom.document.querySelectorAll('button')].some(el => el.textContent === 'Retry'), false);
      const refresh = dom.document.querySelector<HTMLButtonElement>('button[aria-label="Ready Agent: Refresh models"]');
      if (selection) { assert.ok(refresh); await click(refresh); }
      else assert.equal(refresh, null);
      await click(trigger());
      const pending = dom.document.querySelector('[role="group"][aria-label="Agent"]');
      assert.match(pending?.textContent ?? '', /Loading models/);
      const ready = dom.document.querySelector('[role="group"][aria-label="Ready Agent"]');
      assert.match(ready?.textContent ?? '', /Family/);
      await click(trigger());
    }
    assert.deepEqual(retried, ['ready']);
  } finally { await dom.cleanup(); }
});

test('draft refresh appears only for the selected external agent and preserves its selection', async () => {
  const dom = installTranscriptDom();
  const retried: Array<string | undefined> = [];
  let selectionWrites = 0;
  try {
    for (const executorId of [undefined, 'agent', 'other', undefined]) {
      const selection = executorId ? { executorId, configuration: { model: 'opaque-high' } } : undefined;
      const render = (loadingIds: string[] = []) => dom.render(<LocaleProvider locale="en"><ComposerModelPicker label="Native" choices={choices}
        executor={{ catalog: [catalog[0]!, { ...catalog[0]!, id: 'other', displayName: 'Other Agent' }],
          selection, loadingIds,
          onSelect() { selectionWrites++; }, onSetup() {}, onRetry: id => { retried.push(id); }, onNewTask() {} }}
      /></LocaleProvider>);
      await render();
      const { click, trigger } = actions(dom);
      const refresh = (name: string) => dom.document.querySelector<HTMLButtonElement>(`button[aria-label="${name}: Refresh models"]`);
      if (!executorId) {
        assert.equal(refresh('Agent'), null);
        assert.equal(refresh('Other Agent'), null);
        continue;
      }
      const name = executorId === 'agent' ? 'Agent' : 'Other Agent';
      const otherName = executorId === 'agent' ? 'Other Agent' : 'Agent';
      assert.ok(refresh(name));
      assert.equal(refresh(otherName), null);
      await click(refresh(name));
      assert.equal(trigger()?.textContent, 'Family');
      await render([executorId === 'agent' ? 'other' : 'agent']);
      assert.notEqual(refresh(name)?.getAttribute('aria-disabled'), 'true');
      await render([executorId]);
      assert.equal(refresh(name)?.getAttribute('aria-disabled'), 'true');
      await click(refresh(name));
    }
    assert.deepEqual(retried, ['agent', 'other']);
    assert.equal(selectionWrites, 0);
  } finally { await dom.cleanup(); }
});

for (const readiness of ['restore_failed', 'authentication_required', 'history_only', 'history_gap'] as const)
test(`${readiness} keeps inspection failures actionable alongside the cached recovery action`, async () => {
  const dom = installTranscriptDom();
  const retried: Array<string | undefined> = [];
  const recovered: string[] = [];
  const render = (error?: string) => dom.render(<LocaleProvider locale="en"><Composer
    activeSession={session('external')}
    executorPicker={{ catalog: [{ ...catalog[0]!, readiness, supportsModelChange: false, supportsModeChange: false }],
      fixed: true,
      selection: { executorId: 'agent', configuration: { model: 'opaque-high', mode: 'plan' } }, error,
      onSelect() { assert.fail('inspection retry must not configure the Agent'); },
      onRestore() { recovered.push('restore'); }, onSetup() { recovered.push('setup'); },
      onRetry: id => { retried.push(id); }, onNewTask() { recovered.push('new'); } }}
    onSend={() => { assert.fail('inspection retry must not send a message'); }} onStop={() => undefined}
  /></LocaleProvider>);
  const recovery = () => dom.document.querySelector('.maka-executor-recovery');
  try {
    await render();
    assert.equal(recovery()?.getAttribute('data-state'), readiness);
    const recoveryText = recovery()?.textContent;
    assert.equal(dom.document.querySelector('.maka-executor-notice'), null);
    await render('Host inspection disconnected');
    const notice = dom.document.querySelector('.maka-executor-notice');
    assert.ok(notice, 'a failed inspection must not be hidden by the cached readiness');
    assert.match(notice.textContent ?? '', /failed/);
    await actions(dom).click(notice.querySelector('button'));
    assert.deepEqual(retried, [undefined], 'retry only re-inspects the Session');
    assert.deepEqual(recovered, [], 'inspection retry must not invoke the cached recovery action');
    assert.equal(actions(dom).trigger()?.textContent, 'Family');
    assert.equal(recovery()?.textContent, recoveryText);
    await actions(dom).click(recovery()?.querySelector('button'));
    assert.deepEqual(recovered, [readiness === 'restore_failed' ? 'restore' : readiness === 'authentication_required' ? 'setup' : 'new']);
    await render();
    assert.equal(dom.document.querySelector('.maka-executor-notice'), null, 'successful inspection clears only the read error');
    assert.equal(recovery()?.textContent, recoveryText, 'the independent recovery action stays available');
  } finally { await dom.cleanup(); }
});

for (const readiness of ['ready', 'restorable', 'restoring'] as const)
test(`${readiness} inspections keep errors actionable without exposing automatic recovery`, async () => {
  const dom = installTranscriptDom();
  const retried: Array<string | undefined> = [];
  const render = (error?: string) => dom.render(<LocaleProvider locale="en"><Composer
    activeSession={readiness === 'ready' ? undefined : session('external')}
    executorPicker={{ catalog: [{ ...catalog[0]!, readiness, supportsModelChange: false, supportsModeChange: false }],
      fixed: readiness !== 'ready',
      selection: { executorId: 'agent', configuration: { model: 'opaque-high', mode: 'plan' } }, error,
      onSelect() { assert.fail('inspection retry must not configure the Agent'); },
      onRestore() { assert.fail('inspection retry must not restore the Agent'); },
      onSetup() {}, onRetry: id => { retried.push(id); }, onNewTask() {} }}
    onSend={() => undefined} onStop={() => undefined}
  /></LocaleProvider>);
  try {
    await render();
    assert.equal(dom.document.querySelector('.maka-executor-recovery'), null);
    assert.equal(dom.document.querySelector('.maka-executor-notice'), null);
    await render('Host inspection disconnected');
    assert.equal(dom.document.querySelector('.maka-executor-recovery'), null);
    assert.match(dom.document.querySelector('.maka-executor-notice')?.textContent ?? '', /failed/);
    await actions(dom).click([...dom.document.querySelectorAll('button')].find(el => el.textContent === 'Retry'));
    assert.deepEqual(retried, [undefined]);
    assert.equal(actions(dom).trigger()?.textContent, 'Family', 'a failed read preserves the cached model label');
    await render();
    assert.equal(dom.document.querySelector('.maka-executor-notice'), null, 'successful inspection clears the error');
    assert.equal(dom.document.querySelector('.maka-executor-recovery'), null);
  } finally { await dom.cleanup(); }
});

test('saved model, effort and mode controls retain their labels through restoration without permitting edits', async () => {
  const dom = installTranscriptDom();
  try {
    let labels: string[] | undefined;
    for (const readiness of ['restorable', 'restoring', 'restore_failed', 'ready'] as const) {
      await dom.render(<LocaleProvider locale="en"><ComposerModelPicker label="Native" choices={choices}
        executor={{ catalog: [{ ...catalog[0]!, readiness,
          supportsModelChange: readiness === 'ready', supportsModeChange: readiness === 'ready' }],
          fixed: true,
          selection: { executorId: 'agent', configuration: { model: 'opaque-high', mode: 'plan' } },
          onSelect() { assert.fail('restoration must not change saved configuration'); },
          onSetup() {}, onRetry() {}, onNewTask() {}, onRestore() {} }}
      /></LocaleProvider>);
      const selectors = ['.maka-model-switcher-trigger', '.maka-thinking-level-selector', '.maka-executor-mode-selector'];
      const buttons = selectors.map(selector => dom.document.querySelector<HTMLButtonElement>(selector + ' button'));
      assert.ok(buttons.every(Boolean), `all three controls exist in ${readiness}`);
      const current = buttons.map(button => button!.textContent!);
      labels ??= current;
      assert.deepEqual(current, labels);
      for (const button of buttons) {
        assert.equal(button!.getAttribute('aria-disabled') === 'true' || button!.disabled,
          readiness !== 'ready', `only live capabilities allow changes in ${readiness}`);
      }
    }
  } finally { await dom.cleanup(); }
});
