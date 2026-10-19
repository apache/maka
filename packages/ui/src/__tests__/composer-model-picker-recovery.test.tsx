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
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import * as React from 'react';
import { act, createRef, useState } from 'react';
import { MakaClientPluginSdkModule, MakaClientSlotCore, MakaClientSlotProvider } from '../client-plugin-slots.js';
import type { SessionSummary } from '@maka/core/session';
import type { ExecutorSelection } from '@maka/core/executor-catalog';
import type { ChatModelChoice } from '@maka/core/chat-model-choice';
import { Composer, type ComposerHandle } from '../composer.js';
import { ComposerModelPicker, type ComposerExecutorPicker } from '../composer-model-picker.js';
import { highestExecutorModelVariant } from '../executor-model-presentation.js';
import { LocaleProvider } from '../locale-context.js';
import { installTranscriptDom } from './transcript-test-dom.js';
import { deriveComposerModelSwitchAvailability } from '../composer-helpers.js';

const choices: ChatModelChoice[] = ['first', 'second'].map(connectionId => ({
  connectionId, connectionSlug: connectionId, connectionName: connectionId, providerType: 'openai',
  providerLabel: 'OpenAI', model: 'gpt-6.1-sol', label: 'GPT-6.1 Sol', isDefault: false,
  contextWindow: 1_048_576, thinkingLevels: ['low', 'high'],
}));
const session = (id: string) => ({ id, llmConnectionId: 'first', llmConnectionSlug: 'first', model: 'gpt-6.1-sol' }) as SessionSummary;
const catalog: ComposerExecutorPicker['catalog'] = [{
  id: 'agent', displayName: 'Agent', readiness: 'ready', supportsModelChange: true, supportsAttachments: false,
  currentModel: 'opaque-high', currentMode: 'plan', supportsModeChange: true,
  models: [{ id: 'opaque-high', name: 'Family High' }, { id: 'opaque-low', name: 'Family Low' }, { id: 'other', name: 'Other' }],
  modelGroups: [{ id: 'family', name: 'Family', variants: [{ modelId: 'opaque-high', level: 'high' }, { modelId: 'opaque-low', level: 'low' }] }],
  modes: [{ id: 'plan', name: 'Plan' }, { id: 'code', name: 'Code' }],
}];
function actions(dom: ReturnType<typeof installTranscriptDom>) {
  return {
    click: async (element: Element | null | undefined) => {
      assert.ok(element);
      await act(async () => { element.dispatchEvent(new dom.window.Event('click', { bubbles: true })); });
    },
    option: (name: string) => [...dom.document.querySelectorAll('[role="option"]')].find(el => el.textContent === name),
    trigger: (selector = '.maka-model-switcher-trigger') => dom.document.querySelector(selector + ' button'),
  };
}

test('unselected Agents retain sign-in and discovery retry without committing a selection', async () => {
  const dom = installTranscriptDom();
  const setup: string[] = [];
  let retries = 0;
  try {
    for (const readiness of ['authentication_required', 'unavailable'] as const) {
      await dom.render(<LocaleProvider locale="en"><ComposerModelPicker label="Native" choices={choices}
        executor={{ catalog: [{ ...catalog[0]!, readiness }],
          onSelect() { assert.fail('recovery must not select an unavailable Agent'); },
          onSetup: id => { setup.push(id!); }, onRetry: () => { retries++; }, onNewTask() {} }}
      /></LocaleProvider>);
      const { click } = actions(dom);
      await click([...dom.document.querySelectorAll('button')].find(el => el.textContent === (readiness === 'unavailable' ? 'Retry' : 'Go to sign in')));
    }
    assert.deepEqual(setup, ['agent']);
    assert.equal(retries, 1);
  } finally { await dom.cleanup(); }
});

test('the real Codex contribution shares one Composer picker with native and ACP models', async () => {
  let factory!: (require: (id: string) => unknown) => { apply(context: unknown): void };
  runInNewContext(readFileSync(new URL('../../../../scripts/plugins/codex-app-server-executor/client.js', import.meta.url), 'utf8'), {
    AbortController,
    window: { __MakaModuleLoader__: { load: (entry: { factory: typeof factory }) => { factory = entry.factory; } } },
  });
  const core = new MakaClientSlotCore();
  let loads = 0;
  const client = factory(id => {
    if (id === 'react') return React;
    if (id === '@maka/ui/client-plugin') return MakaClientPluginSdkModule;
    throw new Error(`Unknown client module: ${id}`);
  });
  client.apply({ slots: core, remote: { call: async () => {
    loads++;
    if (loads === 1) throw new Error('Temporary discovery failure');
    return [{ model: 'codex-model', displayName: 'Codex model', defaultReasoningEffort: 'high', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }] }];
  } }, style() {} });
  const dom = installTranscriptDom();
  dom.window.getSelection = () => null;
  dom.document.getSelection = () => null;
  const writes: unknown[] = [];
  let finish!: () => void;
  const ref = createRef<ComposerHandle>();
  function Frame({ external = false }: { external?: boolean }) {
    const [target, setTarget] = useState<import('../client-plugin-slots.js').MakaClientExecutorTarget>();
    const [selection, setSelection] = useState<ExecutorSelection | undefined>(external
      ? { executorId: 'agent', configuration: { model: 'opaque-high', mode: 'plan' } } : undefined);
    return <MakaClientSlotProvider core={core}><LocaleProvider locale="en"><Composer ref={ref}
      activeSession={external ? session('acp') : undefined}
      activeModelLabel="Native" modelChoices={choices}
      renderProviderMark={type => <span data-provider-brand={type} />}
      newChatModel={{ llmConnectionId: 'first', llmConnectionSlug: 'first', model: 'gpt-6.1-sol' }}
      onPickNewChatModel={value => { writes.push(value); }}
      executorTarget={target} onExecutorTargetChange={next => new Promise<void>(resolve => {
        writes.push(next); finish = () => { setTarget(next); setSelection(undefined); resolve(); };
      })}
      executorPicker={{ catalog, fixed: external, selection,
        onSelect: next => { writes.push(next); setSelection(next); setTarget(undefined); }, onSetup() {}, onRetry() {}, onNewTask() {} }}
      onSend={() => undefined} onStop={() => undefined}
    /></LocaleProvider></MakaClientSlotProvider>;
  }
  try {
    await dom.render(<Frame />);
    assert.equal(loads, 0, 'mounting a native new task must not start Codex');
    const { click, trigger, option } = actions(dom);
    await act(async () => {
      const event = new dom.window.Event('keydown', { bubbles: true });
      Object.defineProperty(event, 'key', { value: 'ArrowDown' });
      trigger()!.dispatchEvent(event);
    });
    assert.equal(loads, 1);
    await click([...dom.document.querySelectorAll('button')].find(el => el.textContent === 'Retry'));
    assert.equal(loads, 2, 'failed plugin discovery can be retried');
    assert.equal(dom.document.querySelectorAll('.maka-model-switcher-trigger').length, 1);
    assert.ok(dom.document.querySelector('[role="group"][aria-label="Agent"]'));
    assert.ok(dom.document.querySelector('[role="group"][aria-label="first"]'));
    assert.ok(option('Codex model')?.querySelector('[data-provider-brand="openai"]'), 'contributed models use the same provider mark as native models');
    await act(async () => { ref.current?.setText('Continue'); });
    await click(option('Codex model'));
    assert.deepEqual(writes.at(-1), { executorId: 'codex.app-server', model: 'codex-model', thinkingLevel: 'high' });
    assert.equal(dom.document.querySelector('button[aria-label="Send"]')?.getAttribute('aria-disabled'), 'true');
    await act(async () => { finish(); });
    assert.match(trigger()?.textContent ?? '', /Codex.*Codex model/);
    await click(trigger('.maka-thinking-level-selector'));
    await click(option('Low'));
    assert.deepEqual(writes.at(-1), { executorId: 'codex.app-server', model: 'codex-model', thinkingLevel: 'low' });
    await act(async () => { finish(); });
    await click(trigger());
    await click(option('Other'));
    assert.deepEqual(writes.at(-1), { executorId: 'agent', configuration: { model: 'other' } });
    assert.equal(trigger()?.textContent, 'Agent · Other');
    await click(trigger());
    await click(dom.document.querySelector('[role="group"][aria-label="second"] [role="option"]'));
    assert.deepEqual(writes.at(-1), { llmConnectionId: 'second', llmConnectionSlug: 'second', model: 'gpt-6.1-sol' });
    await dom.render(<Frame key="external" external />);
    assert.equal(trigger()?.textContent, 'Family');
    assert.equal(trigger('.maka-executor-mode-selector')?.textContent, 'Plan');
    await click(trigger());
    assert.ok(option('Other'));
    assert.equal(option('Codex model'), undefined, 'an existing ACP session stays on its executor');
    assert.equal(loads, 2, 'browsing a fixed ACP session must not load Codex');
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
      executor={{ catalog, selection: { executorId: 'agent', configuration: { model: 'opaque-high' } }, fixed: true,
        onSelect: async () => { throw Error('offline'); }, onSetup() {}, onRetry() {}, onNewTask() {} }}
    /></LocaleProvider>);
    const { click, option, trigger } = actions(dom);
    await click(trigger());
    assert.equal(dom.document.querySelector('[role="group"][aria-label="OpenAI"]'), null);
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
