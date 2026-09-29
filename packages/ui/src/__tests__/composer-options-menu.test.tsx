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
import { act } from 'react';
import type { ChatModelChoice } from '@maka/core/chat-model-choice';
import type { ThinkingLevel } from '@maka/core/model-thinking';
import type { SessionSummary } from '@maka/core/session';
import { Composer } from '../composer.js';
import { LocaleProvider } from '../locale-context.js';
import { installTranscriptDom } from './transcript-test-dom.js';

const choice: ChatModelChoice = {
  connectionId: 'relay',
  connectionSlug: 'relay',
  connectionName: 'Relay',
  providerType: 'custom',
  providerLabel: 'Custom',
  model: 'gpt-5.5',
  label: 'GPT-5.5',
  isDefault: true,
  thinkingLevels: ['low', 'high'],
  supportsFast: true,
};

function session(id: string): SessionSummary {
  return { id, llmConnectionId: choice.connectionId, llmConnectionSlug: choice.connectionSlug, model: choice.model } as SessionSummary;
}

test('the Fast row writes the toggle and "Model default" clears the effort', async () => {
  const dom = installTranscriptDom();
  dom.window.getSelection = () => null;
  const fast: boolean[] = [];
  const levels: (ThinkingLevel | undefined)[] = [];
  const click = async (element: Element | null | undefined) => {
    assert.ok(element);
    await act(async () => { element.dispatchEvent(new dom.window.Event('click', { bubbles: true })); });
  };
  const trigger = () => dom.document.querySelector('.maka-composer-options-trigger');
  const row = (role: string, text: string) =>
    [...dom.document.querySelectorAll(`[role="${role}"]`)].find((element) => element.textContent?.startsWith(text));
  try {
    await dom.render(
      <LocaleProvider locale="en">
        <Composer
          activeSession={session('a')}
          activeModelConnectionId={choice.connectionId}
          activeModelConnectionSlug={choice.connectionSlug}
          activeModel={choice.model}
          activeModelLabel={choice.label}
          activeThinkingLevels={choice.thinkingLevels}
          activeThinkingLevel="high"
          modelChoices={[choice]}
          onModelChange={() => undefined}
          onThinkingLevelChange={(level) => { levels.push(level); }}
          onFastChange={(enabled) => { fast.push(enabled); }}
          onSend={() => undefined}
          onStop={() => undefined}
        />
      </LocaleProvider>,
    );
    await click(trigger());
    await click(row('menuitemcheckbox', 'Fast'));
    assert.deepEqual(fast, [true]);

    await click(trigger());
    await click(row('menuitem', 'Effort'));
    await click(row('menuitemradio', 'Model default'));
    assert.deepEqual(levels, [undefined]);
  } finally {
    await dom.cleanup();
  }
});

test('a Fast row is only offered when the model supports it', async () => {
  const dom = installTranscriptDom();
  dom.window.getSelection = () => null;
  try {
    await dom.render(
      <LocaleProvider locale="en">
        <Composer
          activeSession={session('a')}
          activeModelConnectionId={choice.connectionId}
          activeModelConnectionSlug={choice.connectionSlug}
          activeModel={choice.model}
          modelChoices={[{ ...choice, supportsFast: false }]}
          onModelChange={() => undefined}
          onFastChange={() => undefined}
          onSend={() => undefined}
          onStop={() => undefined}
        />
      </LocaleProvider>,
    );
    const trigger = dom.document.querySelector('.maka-composer-options-trigger');
    assert.ok(trigger);
    await act(async () => { trigger.dispatchEvent(new dom.window.Event('click', { bubbles: true })); });
    assert.equal(dom.document.querySelector('[role="menuitemcheckbox"]'), null);
  } finally {
    await dom.cleanup();
  }
});

test('switching Sessions drops a Fast pick that is still settling', async () => {
  const dom = installTranscriptDom();
  dom.window.getSelection = () => null;
  const render = (id: string) => dom.render(
    <LocaleProvider locale="en">
      <Composer
        activeSession={session(id)}
        activeModelConnectionId={choice.connectionId}
        activeModelConnectionSlug={choice.connectionSlug}
        activeModel={choice.model}
        activeModelLabel={choice.label}
        modelChoices={[choice]}
        onModelChange={() => undefined}
        onFastChange={() => new Promise<void>(() => undefined)}
        onSend={() => undefined}
        onStop={() => undefined}
      />
    </LocaleProvider>,
  );
  const details = () => dom.document.querySelector('.maka-composer-options-details')?.textContent ?? '';
  try {
    await render('a');
    const trigger = dom.document.querySelector('.maka-composer-options-trigger');
    assert.ok(trigger);
    await act(async () => { trigger.dispatchEvent(new dom.window.Event('click', { bubbles: true })); });
    const fastRow = dom.document.querySelector('[role="menuitemcheckbox"]');
    assert.ok(fastRow);
    await act(async () => { fastRow.dispatchEvent(new dom.window.Event('click', { bubbles: true })); });
    assert.match(details(), /Fast/, 'the pending pick shows on the Session it was made in');
    await render('b');
    assert.doesNotMatch(details(), /Fast/, 'another Session does not inherit the pending pick');
  } finally {
    await dom.cleanup();
  }
});
