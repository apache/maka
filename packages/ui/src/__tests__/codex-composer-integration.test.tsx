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
import type { ExecutorSelection } from '@maka/core/executor-catalog';
import { Composer, type ComposerHandle } from '../composer.js';
import { LocaleProvider } from '../locale-context.js';
import { installTranscriptDom } from './transcript-test-dom.js';
import { actions, catalog, choices, session } from './composer-model-picker-fixture.js';

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
