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
import { act, useState } from 'react';
import type { ChatModelChoice } from '@maka/core/chat-model-choice';
import {
  ExecutorModelPicker,
  ExecutorThinkingLevelSelector,
  type ExecutorSelection,
  type ExecutorModelPickerProps,
} from '../executor-model-picker.js';
import { highestExecutorModelVariant } from '../executor-model-presentation.js';
import { NewChatModelPicker } from '../chat-model-switcher.js';
import { Composer } from '../composer.js';
import { exactModelChoiceValue } from '../chat-model-helpers.js';
import { LocaleProvider } from '../locale-context.js';
import { installTranscriptDom } from './transcript-test-dom.js';

const catalog: ExecutorModelPickerProps['catalog'] = [
  {
    id: 'antigravity',
    displayName: 'Antigravity',
    readiness: 'ready',
    models: Array.from({ length: 32 }, (_, index) => ({
      id: `model-${index}`,
      ...(index === 0 ? { providerType: 'google' as const } : {}),
      name: index === 0 ? 'Gemini 3.8 Flash' : `Agent model ${index}`,
    })),
    currentModel: 'model-0',
    supportsAttachments: false,
    supportsModelChange: true,
  },
];
const choices: ChatModelChoice[] = [
  {
    connectionId: 'native',
    connectionSlug: 'native',
    connectionName: 'My account',
    providerType: 'openai',
    providerLabel: 'OpenAI',
    model: 'native-model',
    label: 'Native model',
    description: 'Native model description',
    isDefault: true,
    thinkingLevels: [],
  },
  {
    connectionId: 'native',
    connectionSlug: 'native',
    connectionName: 'My account',
    providerType: 'openai',
    providerLabel: 'OpenAI',
    model: 'native-model-2',
    label: 'Native model 2',
    description: 'Alternative native model',
    isDefault: false,
    thinkingLevels: [],
  },
];

test('the picker shows a generic loading state until the executor catalog arrives', async () => {
  const dom = installTranscriptDom();
  const selections: unknown[] = [];
  const render = (loading: boolean) => dom.render(
    <LocaleProvider locale="zh-CN">
      <ExecutorModelPicker
        catalog={loading ? [] : [{ ...catalog[0]!, id: 'antigravity-acp' }]}
        loading={loading}
        onSelect={(selection) => { selections.push(selection); }}
        onSetup={() => {}}
        onRetry={() => {}}
        onNewTask={() => {}}
      >
        <span>Native models</span>
      </ExecutorModelPicker>
    </LocaleProvider>,
  );
  const click = async (element: Element | null | undefined) => {
    assert.ok(element);
    await act(async () => { element.dispatchEvent(new dom.window.Event('click', { bubbles: true })); });
  };
  try {
    await render(true);
    await click(dom.document.querySelector('.maka-executor-selector'));
    assert.ok(dom.document.querySelector('.maka-executor-picker-entry-status[role="status"]')?.textContent?.includes('正在读取执行者与模型'));
    assert.ok(![...dom.document.querySelectorAll<HTMLButtonElement>('.maka-executor-picker-rail button')]
      .some((button) => button.textContent?.includes('Antigravity')));
    assert.equal(dom.document.querySelectorAll('.maka-executor-picker-model').length, 0);
    assert.deepEqual(selections, []);

    await render(false);
    assert.equal([...dom.document.querySelectorAll('.maka-executor-picker-rail button')]
      .filter((button) => button.textContent?.includes('Antigravity')).length, 1);
    await click([...dom.document.querySelectorAll<HTMLButtonElement>('.maka-executor-picker-rail button')]
      .find((button) => button.textContent?.includes('Antigravity')));
    await click([...dom.document.querySelectorAll('.maka-executor-picker-model')]
      .find((model) => model.textContent?.includes('Gemini 3.8 Flash')));
    assert.deepEqual(selections, [{ executorId: 'antigravity-acp', configuration: { model: 'model-0' } }]);
  } finally {
    await dom.cleanup();
  }
});

test('failed Antigravity discovery closes the picker before opening external-agent settings', async () => {
  const dom = installTranscriptDom();
  let setupOpened = false;
  const render = (loading: boolean) => dom.render(
    <LocaleProvider locale="zh-CN">
      <ExecutorModelPicker
        catalog={loading ? [] : [{
          id: 'antigravity-acp',
          displayName: 'Antigravity',
          readiness: 'unavailable',
          models: [],
          supportsAttachments: false,
          supportsModelChange: false,
        }]}
        loading={loading}
        onSelect={() => assert.fail('An unavailable executor cannot be selected')}
        onSetup={() => { setupOpened = true; }}
        onRetry={() => {}}
        onNewTask={() => {}}
      />
    </LocaleProvider>,
  );
  const click = async (element: Element | null | undefined) => {
    assert.ok(element);
    await act(async () => { element.dispatchEvent(new dom.window.Event('click', { bubbles: true })); });
  };
  try {
    await render(true);
    await click(dom.document.querySelector('.maka-executor-selector'));
    await render(false);
    await click([...dom.document.querySelectorAll<HTMLButtonElement>('.maka-executor-picker-rail button')]
      .find((button) => button.textContent?.includes('Antigravity')));
    assert.ok(dom.document.querySelector('.maka-executor-picker-models')?.textContent?.includes('当前不可用'));
    await click(dom.document.querySelector('.maka-executor-picker-readiness button'));
    assert.equal(setupOpened, true);
    assert.equal(dom.document.querySelector('.maka-executor-selector')?.getAttribute('aria-expanded'), 'false');
  } finally {
    await dom.cleanup();
  }
});

for (const nativeModel of ['native-model', 'native-model-2']) {
  test(`the Composer native fallback commits Maka with ${nativeModel} after browsing an external executor`, async () => {
    const dom = installTranscriptDom();
    dom.window.getSelection = () => null;
    const selected: unknown[] = [];
    function Harness() {
      const [selection, setSelection] = useState<ExecutorSelection>();
      const [model, setModel] = useState({
        llmConnectionId: 'native', llmConnectionSlug: 'native', model: 'native-model',
      });
      return (
        <LocaleProvider locale="en">
          <Composer
            executorPicker={{
              catalog, selection,
              onSelect: (next) => { selected.push(next); setSelection(next); },
              onSetup: () => {}, onRetry: () => {}, onNewTask: () => {},
            }}
            modelChoices={choices}
            newChatModel={model}
            onPickNewChatModel={setModel}
            onSend={() => assert.fail('Selecting a model must not send the draft')}
            onStop={() => {}}
          />
        </LocaleProvider>
      );
    }
    const click = async (element: Element | null | undefined) => {
      assert.ok(element);
      await act(async () => { element.dispatchEvent(new dom.window.Event('click', { bubbles: true })); });
    };
    const button = (text: string) => [...dom.document.querySelectorAll('button')].find(
      (element) => element.textContent === text,
    );
    try {
      await dom.render(<Harness />);
      await click(dom.document.querySelector('.maka-executor-selector'));
      await click(button('Antigravity'));
      assert.equal(selected.length, 0, 'browsing must not change the executor');
      await click([...dom.document.querySelectorAll('.maka-executor-picker-model')].find(
        (element) => element.textContent?.includes('Agent model 31'),
      ));
      assert.deepEqual(selected, [{ executorId: 'antigravity', configuration: { model: 'model-31' } }]);
      await click(dom.document.querySelector('.maka-executor-selector'));
      await click(button('Maka'));
      assert.equal(selected.length, 1, 'browsing back to Maka must not commit it');
      assert.equal(dom.document.querySelector('.maka-executor-picker-native [aria-haspopup="listbox"]'), null, 'native models are directly visible');
      await click([...dom.document.querySelectorAll('[role="option"]')].find(
        (element) => element.textContent === choices.find((choice) => choice.model === nativeModel)!.label,
      ));
      assert.equal(selected.length, 2);
      assert.equal(selected.at(-1), undefined, 'the native choice must clear the external executor');
      assert.ok(!dom.document.querySelector('.maka-executor-selector')?.textContent?.includes('Antigravity'));
    } finally {
      await dom.cleanup();
    }
  });
}

test('executor choice shares the native searchable list and exposes every external model with exact identity', async () => {
  const dom = installTranscriptDom();
  const selected: unknown[] = [];
  function Harness() {
    const [selection, setSelection] = useState<ExecutorSelection>();
    return (
      <LocaleProvider locale="en">
        <ExecutorModelPicker
          catalog={catalog}
          renderProviderMark={(type) => <span data-external-mark={type} />}
          selection={selection}
          onSelect={(value) => {
            selected.push(value);
            setSelection(value);
          }}
          onSetup={() => {}}
          onRetry={() => {}}
          onNewTask={() => {}}
        >
          <NewChatModelPicker
            label="Native model"
            choices={choices}
            currentValue={exactModelChoiceValue('native', 'native', 'native-model')}
            currentProviderType="openai"
            renderProviderMark={() => <span data-native-mark>Provider icon</span>}
            onPick={() => {
              selected.push(undefined);
              setSelection(undefined);
            }}
          />
        </ExecutorModelPicker>
      </LocaleProvider>
    );
  }
  const click = async (selector: string) => {
    const element = dom.document.querySelector<HTMLElement>(selector);
    assert.ok(element, selector);
    await act(async () => {
      element.dispatchEvent(new dom.window.Event('click', { bubbles: true }));
    });
  };
  const choose = async (text: string) => {
    const row = [
      ...dom.document.querySelectorAll<HTMLElement>('[role="option"]'),
    ].find((row) => row.textContent?.includes(text));
    assert.ok(row, text);
    await act(async () => {
      row.dispatchEvent(new dom.window.Event('click', { bubbles: true }));
    });
  };
  try {
    await dom.render(<Harness />);
    await click('.maka-executor-selector');
    assert.ok(dom.document.querySelector('.maka-executor-picker-search input'));
    assert.ok(dom.document.querySelector('.maka-executor-picker-native .modelPickerOptionLabel bdi'), 'reuse main label formatting');
    assert.equal(dom.document.querySelectorAll('.maka-executor-picker-native [role="option"]').length, 2);
    const antigravity = [...dom.document.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent?.includes('Antigravity'),
    );
    assert.ok(antigravity);
    await act(async () => {
      antigravity.dispatchEvent(new dom.window.Event('click', { bubbles: true }));
    });
    assert.equal(selected.length, 0, 'browsing an executor does not commit it');
    const rows = [
      ...dom.document.querySelectorAll<HTMLElement>('.maka-executor-picker-model[role="option"]'),
    ];
    assert.equal(rows.length, 32, 'only the actual model catalog is rendered');
    assert.ok(!rows.some((row) => row.textContent?.includes('Agent default')));
    assert.ok(rows[0]?.querySelector('[data-external-mark="google"]'), 'Gemini uses the existing provider icon');
    assert.equal(rows[1]?.querySelector('[data-external-mark]'), null, 'unknown models receive no guessed icon');
    for (const model of catalog[0]!.models)
      assert.ok(rows.some((row) => row.textContent?.includes(model.name)));
    assert.equal(rows[0]?.getAttribute('aria-selected'), 'true', 'the current catalog model is reflected');
    const model31 = rows.find((row) => row.textContent?.includes('Agent model 31'));
    assert.ok(model31);
    await act(async () => {
      model31.dispatchEvent(new dom.window.Event('click', { bubbles: true }));
    });
    assert.deepEqual(selected.at(-1), {
      executorId: 'antigravity',
      configuration: { model: 'model-31' },
    });
    await click('.maka-executor-selector');
    const maka = [...dom.document.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent === 'Maka',
    );
    assert.ok(maka);
    await act(async () => {
      maka.dispatchEvent(new dom.window.Event('click', { bubbles: true }));
    });
    assert.deepEqual(selected.at(-1), {
      executorId: 'antigravity',
      configuration: { model: 'model-31' },
    });
    assert.ok(dom.document.body.textContent?.includes('My account'));
    assert.ok(dom.document.querySelector('[data-native-mark]'));
    assert.equal(dom.document.querySelector('.maka-executor-picker-native small'), null, 'main native rows have no model-ID second line');
    await choose('Native model 2');
    assert.equal(selected.at(-1), undefined);
    assert.equal(dom.document.querySelector('.maka-executor-selector')?.getAttribute('aria-expanded'), 'false', 'choosing a native model closes the shared panel');
  } finally {
    await dom.cleanup();
  }
});

for (const [readiness, notice] of [
  ['history_only', '歷史仍可閱讀'],
  ['history_gap', '進度可能超出已儲存歷史'],
] as const) test(`${readiness} keeps the executor fixed and offers a new task`, async () => {
  const dom = installTranscriptDom();
  let newTasks = 0;
  try {
    await dom.render(
      <LocaleProvider locale="zh-TW">
        <ExecutorModelPicker
          catalog={[{ ...catalog[0]!, readiness }]}
          selection={{ executorId: 'antigravity', configuration: { model: 'model-0' } }}
          fixed
          onSelect={() => assert.fail('History cannot change executor')}
          onSetup={() => {}}
          onRetry={() => {}}
          onNewTask={() => {
            newTasks++;
          }}
        />
      </LocaleProvider>,
    );
    assert.ok(dom.document.body.textContent?.includes(notice));
    const executorTrigger = dom.document.querySelector('.maka-executor-selector');
    assert.notEqual(executorTrigger?.getAttribute('aria-disabled'), 'true');
    const button = [...dom.document.querySelectorAll('button')].find(
      (b) => b.textContent === '建立新任務',
    );
    assert.ok(button);
    await act(() => button.dispatchEvent(new dom.window.Event('click', { bubbles: true })));
    assert.equal(newTasks, 1);
  } finally {
    await dom.cleanup();
  }
});

test('restorable task offers an explicit restore action without selecting a model', async () => {
  const dom = installTranscriptDom();
  let restores = 0;
  try {
    await dom.render(
      <LocaleProvider locale="en">
        <ExecutorModelPicker
          catalog={[{ ...catalog[0]!, readiness: 'restorable' }]}
          selection={{ executorId: 'antigravity', configuration: { model: 'model-0' } }}
          fixed
          onSelect={() => assert.fail('Restoration must not commit a model choice')}
          onRestore={async () => { restores++; }}
          onSetup={() => {}}
          onRetry={() => {}}
          onNewTask={() => assert.fail('The Session is restorable')}
        />
      </LocaleProvider>,
    );
    assert.match(dom.document.body.textContent ?? '', /Restore it before continuing/u);
    const button = [...dom.document.querySelectorAll('button')].find(
      candidate => candidate.textContent === 'Restore Session',
    );
    assert.ok(button);
    await act(async () => button.dispatchEvent(new dom.window.Event('click', { bubbles: true })));
    assert.equal(restores, 1);
  } finally { await dom.cleanup(); }
});

test('restoring task shows progress without offering another action', async () => {
  const dom = installTranscriptDom();
  try {
    await dom.render(
      <LocaleProvider locale="en">
        <ExecutorModelPicker
          catalog={[{ ...catalog[0]!, readiness: 'restoring' }]}
          selection={{ executorId: 'antigravity', configuration: { model: 'model-0' } }}
          fixed
          onSelect={() => assert.fail('Restoration is pending')}
          onSetup={() => assert.fail('Setup is unavailable while restoring')}
          onRetry={() => assert.fail('Retry is unavailable while restoring')}
          onNewTask={() => assert.fail('New Task is unavailable while restoring')}
        />
      </LocaleProvider>,
    );
    assert.match(dom.document.body.textContent ?? '', /Restoring the external Session/u);
    assert.equal([...dom.document.querySelectorAll('button')].some(button =>
      ['Manage agents', 'Restore Session', 'New Task'].includes(button.textContent ?? '')), false);
  } finally { await dom.cleanup(); }
});

test('unavailable executors can be inspected but never committed', async () => {
  const dom = installTranscriptDom();
  const selections: unknown[] = [];
  try {
    await dom.render(
      <LocaleProvider locale="en">
        <ExecutorModelPicker
          catalog={[{ ...catalog[0]!, readiness: 'authentication_required' }]}
          nativeLabel="Native model"
          onSelect={(selection) => {
            selections.push(selection);
          }}
          onSetup={() => {}}
          onRetry={() => {}}
          onNewTask={() => {}}
        >
          <span>Native models</span>
        </ExecutorModelPicker>
      </LocaleProvider>,
    );
    const trigger = dom.document.querySelector<HTMLElement>('.maka-executor-selector');
    assert.ok(trigger);
    await act(() => trigger.dispatchEvent(new dom.window.Event('click', { bubbles: true })));
    const entry = [...dom.document.querySelectorAll<HTMLButtonElement>('button')].find((button) =>
      button.textContent?.includes('Antigravity'),
    );
    assert.ok(entry);
    await act(() => entry.dispatchEvent(new dom.window.Event('click', { bubbles: true })));
    assert.match(dom.document.body.textContent ?? '', /Sign in from External Agents settings/);
    assert.deepEqual(selections, []);
  } finally {
    await dom.cleanup();
  }
});


test('native thinking stays beside the composer model trigger and follows executor selection', async () => {
  const dom = installTranscriptDom();
  dom.window.getSelection = () => null;
  const levels: unknown[] = [];
  function Harness() {
    const [selection, setSelection] = useState<ExecutorSelection>();
    return (
      <LocaleProvider locale="en">
        <Composer
          executorPicker={{ catalog, selection, onSelect: setSelection, onSetup: () => {}, onRetry: () => {}, onNewTask: () => {} }}
          modelChoices={choices}
          newChatModel={{ llmConnectionId: 'native', llmConnectionSlug: 'native', model: 'native-model' }}
          onPickNewChatModel={() => {}}
          newChatThinkingLevels={['low', 'high']}
          onNewChatThinkingLevelChange={(level) => { levels.push(level); }}
          onSend={() => {}}
          onStop={() => {}}
        />
      </LocaleProvider>
    );
  }
  const click = async (element: Element | null | undefined) => {
    assert.ok(element);
    await act(async () => { element.dispatchEvent(new dom.window.Event('click', { bubbles: true })); });
  };
  const button = (text: string) => [...dom.document.querySelectorAll('button')].find((element) => element.textContent === text);
  try {
    await dom.render(<Harness />);
    const thinking = () => dom.document.querySelector('.maka-thinking-level-selector');
    assert.ok(thinking(), 'thinking is available while the model panel is closed');
    await click(thinking()?.querySelector('[aria-haspopup="listbox"]'));
    await click([...dom.document.querySelectorAll('[role="option"]')].find((row) => row.textContent === 'High'));
    assert.deepEqual(levels, ['high']);
    await click(dom.document.querySelector('.maka-executor-selector'));
    assert.ok(!thinking()?.closest('.maka-executor-picker-panel'));
    assert.equal(dom.document.querySelectorAll('.maka-thinking-level-selector').length, 1);
    await click(button('Antigravity'));
    assert.ok(thinking(), 'browsing does not change the selected executor');
    await click([...dom.document.querySelectorAll('[role="option"]')].find((row) => row.textContent?.includes('Agent model 1')));
    assert.ok(!thinking(), 'native thinking is not offered for the external executor');
    await click(dom.document.querySelector('.maka-executor-selector'));
    await click(button('Maka'));
    assert.ok(!thinking(), 'browsing native models does not change executor settings');
    await click([...dom.document.querySelectorAll('[role="option"]')].find((row) => row.textContent === 'Native model'));
    assert.ok(thinking(), 'the native thinking control returns after committing a native model');
  } finally {
    await dom.cleanup();
  }
});


test('a failed native choice keeps the shared list open for retry', async () => {
  const dom = installTranscriptDom();
  let attempts = 0;
  try {
    await dom.render(
      <LocaleProvider locale="en">
        <ExecutorModelPicker catalog={catalog} onSelect={() => {}} onSetup={() => {}} onRetry={() => {}} onNewTask={() => {}}>
          <NewChatModelPicker label="Native model" choices={choices} onPick={async () => {
            if (++attempts === 1) throw new Error('selection failed');
          }} />
        </ExecutorModelPicker>
      </LocaleProvider>,
    );
    const trigger = dom.document.querySelector('.maka-executor-selector')!;
    await act(async () => { trigger.dispatchEvent(new dom.window.Event('click', { bubbles: true })); });
    const row = dom.document.querySelector('[role="option"]')!;
    await act(async () => { row.dispatchEvent(new dom.window.Event('click', { bubbles: true })); });
    assert.equal(attempts, 1);
    assert.equal(trigger.getAttribute('aria-expanded'), 'true');
    await act(async () => { row.dispatchEvent(new dom.window.Event('click', { bubbles: true })); });
    assert.equal(attempts, 2);
    assert.equal(trigger.getAttribute('aria-expanded'), 'false');
  } finally {
    await dom.cleanup();
  }
});

const groupedCatalog: ExecutorModelPickerProps['catalog'] = [{
  ...catalog[0]!, currentModel: 'flash-high',
  models: [
    { id: 'flash-high', name: 'Gemini 3.8 Flash (High)', providerType: 'google' },
    { id: 'flash-mid', name: 'Gemini 3.8 Flash (Medium)', providerType: 'google' },
    { id: 'flash-low', name: 'Gemini 3.8 Flash (Low)', providerType: 'google' },
    { id: 'gemini-pro-agent', name: 'Gemini 3.1 Pro (High)', providerType: 'google' },
    { id: 'pro-low', name: 'Gemini 3.1 Pro (Low)', providerType: 'google' },
    { id: 'opaque-unknown', name: 'Unrecognized (High)' },
  ],
  modelGroups: [
    { id: 'flash', name: 'Gemini 3.8 Flash', variants: [{ modelId: 'flash-low', level: 'low' }, { modelId: 'flash-mid', level: 'medium' }, { modelId: 'flash-high', level: 'high' }] },
    { id: 'pro', name: 'Gemini 3.1 Pro', variants: [{ modelId: 'pro-low', level: 'low' }, { modelId: 'gemini-pro-agent', level: 'high' }] },
  ],
}];

test('highest external intensity uses supported levels and opaque IDs regardless of catalog order', () => {
  assert.equal(highestExecutorModelVariant({ id: 'partial', name: 'Partial', variants: [
    { level: 'medium', modelId: 'server-selected-opaque' }, { level: 'low', modelId: 'other-opaque' },
  ] }), 'server-selected-opaque');
  assert.equal(highestExecutorModelVariant({ id: 'complete', name: 'Complete', variants: [
    { level: 'high', modelId: 'gemini-pro-agent' }, { level: 'low', modelId: 'low-opaque' },
  ] }), 'gemini-pro-agent');
});

for (const initial of [undefined, 'flash-high', 'flash-mid']) test(`grouped external models select the highest supported intensity from ${initial}`, async () => {
  const dom = installTranscriptDom();
  dom.window.getSelection = () => null;
  const selected: string[] = [];
  let rejectNext = false;
  let finish!: () => void;
  let hold = false;
  function Harness() {
    const [selection, setSelection] = useState<ExecutorSelection | undefined>(initial ? { executorId: 'antigravity', configuration: { model: initial } } : undefined);
    return <LocaleProvider locale="en"><Composer
      executorPicker={{ catalog: groupedCatalog, selection, onSelect: async next => {
        selected.push(next!.configuration.model!);
        if (hold) await new Promise<void>(resolve => { finish = resolve; });
        if (rejectNext) { rejectNext = false; throw new Error('rejected'); }
        setSelection(next!);
      }, onSetup: () => {}, onRetry: () => {}, onNewTask: () => {} }}
      onSend={() => {}} onStop={() => {}}
    /></LocaleProvider>;
  }
  const click = async (element: Element | undefined | null) => {
    assert.ok(element);
    await act(async () => { element.dispatchEvent(new dom.window.Event('click', { bubbles: true })); });
  };
  const row = (name: string) => [...dom.document.querySelectorAll('[role="option"]')].find(el => el.textContent === name);
  const thinking = () => [...dom.document.querySelectorAll('.maka-thinking-level-selector')].find(el => !el.closest('.maka-executor-picker-panel'));
  const openModels = () => click(dom.document.querySelector('.maka-executor-selector'));
  try {
    await dom.render(<Harness />);
    if (initial) assert.ok(thinking(), 'external intensity is beside the composer model trigger');
    await openModels();
    if (!initial) await click([...dom.document.querySelectorAll('button')].find(el => el.textContent === 'Antigravity'));
    assert.equal(dom.document.querySelectorAll('.maka-executor-picker-model').length, 3);
    if (initial === 'flash-high') rejectNext = true;
    await click(row('Gemini 3.1 Pro'));
    if (initial === 'flash-high') {
      assert.equal(dom.document.querySelector('.maka-executor-selector')?.getAttribute('aria-expanded'), 'true');
      assert.ok(dom.document.querySelector('.maka-executor-selector')?.textContent?.includes('Gemini 3.8 Flash'));
      await click(row('Gemini 3.1 Pro'));
    }
    assert.equal(dom.document.querySelector('.maka-executor-picker-panel .maka-thinking-level-selector'), null, 'all thinking controls stay in the composer footer');
    assert.equal(dom.document.querySelectorAll('.maka-model-switcher-trigger').length, 1, 'the external model replaces the native model trigger');
    assert.equal([...dom.document.querySelectorAll('button')].some(el => el.textContent === 'Cancel'), false);
    assert.equal(selected.at(-1), 'gemini-pro-agent');
    assert.ok(dom.document.querySelector('.maka-executor-selector')?.textContent?.includes('Gemini 3.1 Pro'));
    assert.ok(thinking()?.textContent?.includes('High'));
    await click(thinking()?.querySelector('[aria-haspopup="listbox"]'));
    assert.deepEqual([...dom.document.querySelectorAll('[role="option"]')].filter(el => !el.classList.contains('maka-executor-picker-model')).map(el => el.textContent), ['Low', 'High']);
    hold = true;
    rejectNext = true;
    await click(row('Low'));
    assert.ok(thinking()?.textContent?.includes('High'), 'unconfirmed changes are not displayed');
    await act(async () => { finish(); });
    assert.ok(thinking()?.textContent?.includes('High'), 'failure preserves the original intensity');
    hold = false;
    await click(thinking()?.querySelector('[aria-haspopup="listbox"]'));
    await click(row('Low'));
    assert.equal(selected.at(-1), 'pro-low');
    assert.ok(thinking()?.textContent?.includes('Low'));
    await openModels();
    assert.equal(row('Gemini 3.1 Pro')?.getAttribute('aria-selected'), 'true');
    await click(row('Gemini 3.8 Flash'));
    assert.equal(selected.at(-1), 'flash-high', 'switching base models selects the highest supported level');
    await openModels();
    await click([...dom.document.querySelectorAll('[role="option"]')].find(el => el.textContent?.includes('Unrecognized (High)')));
    assert.equal(selected.at(-1), 'opaque-unknown');
    assert.equal(thinking(), undefined, 'unknown models retain their row and have no invented levels');
  } finally { await dom.cleanup(); }
});

for (const lock of ['disabled', 'readOnly', 'fixed', 'lost'] as const) test(`external thinking respects ${lock} locks`, async () => {
  const dom = installTranscriptDom();
  let calls = 0;
  try {
    await dom.render(<LocaleProvider locale="en"><ExecutorThinkingLevelSelector
      catalog={[{ ...groupedCatalog[0]!, supportsModelChange: lock !== 'fixed', readiness: lock === 'lost' ? 'history_only' : 'ready' }]}
      selection={{ executorId: 'antigravity', configuration: { model: 'flash-high' } }}
      disabled={lock === 'disabled'} isReadOnly={lock === 'readOnly'} fixed={lock === 'fixed'}
      onSelect={() => { calls++; }} onSetup={() => {}} onRetry={() => {}} onNewTask={() => {}}
    /></LocaleProvider>);
    const trigger = dom.document.querySelector<HTMLElement>('[aria-haspopup="listbox"]');
    if (lock === 'readOnly') {
      assert.equal(trigger, null, 'read-only Selector has no interactive trigger');
      assert.equal(calls, 0);
      return;
    }
    assert.ok(trigger);
    assert.ok(trigger.hasAttribute('disabled') || trigger.getAttribute('aria-disabled') === 'true' || trigger.getAttribute('aria-readonly') === 'true');
    await act(async () => { trigger.dispatchEvent(new dom.window.Event('click', { bubbles: true })); });
    assert.equal(calls, 0);
    assert.equal(trigger.getAttribute('aria-expanded'), 'false');
  } finally { await dom.cleanup(); }
});
