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

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BotStore } from '../../../../src/assistant/bot/store.js';
import { InitiativeController } from '../../../../src/assistant/index-initiative/controller.js';
import { InitiativeStore } from '../../../../src/assistant/index-initiative/store.js';
import { readFile } from 'node:fs/promises';
import { note, output, view } from './notebook-output.js';
import { fixture, until } from './fixture.js';

test('shared notebook imports only delivered quick messages and explicitly linked feedback, durably and idempotently', () => {
  const root = mkdtempSync(join(tmpdir(), 'quick-notebook-'));
  const bot = new BotStore(root);
  const store = new InitiativeStore(root, 'test-owner');
  store.lease();
  store.bind({ sessionId: 'owner', cwd: root });
  const ctx = {
    bot: {
      discoveryContext: () => ({
        deliveries: bot.discoveryDeliveries(),
        feedback: bot.discoveryFeedback(),
      }),
    },
  };
  let controller = new InitiativeController(ctx, store, {});
  const post = (id: string, text: string) =>
    bot.post({ id, type: 'discovery', source: 'quick-worker', content: text });
  const user = (id: string, text: string) => {
    bot.post(
      { id, type: 'user_message', source: 'user', content: { text } },
      { id, type: 'user', text, ts: Date.now(), turnId: id },
    );
    bot.delivered(id);
  };
  try {
    post('quick:round:report:0', 'internal investigation text');
    post('quick:round:report:1', 'filtered candidate');
    const [sent] = bot.queueVisibleBatch('sent', [
      {
        text: '今晚活动改为线上，可以在家参加。',
        summary: '活动改期',
        discoveryIds: ['quick:round:report:0'],
      },
    ]);
    const [queued] = bot.queueVisibleBatch('queued', [
      { text: 'transport has not delivered this', discoveryIds: ['quick:round:report:1'] },
    ]);
    controller.refreshNotebook();
    assert.equal(
      controller.notebook.events().length,
      0,
      'handoff and queued messages are not delivery',
    );
    bot.delivered(sent);
    const [ordinary] = bot.queueVisibleBatch('ordinary', [{ text: 'ordinary conversation' }]);
    bot.delivered(ordinary);
    post('unknown-report', 'legacy unknown report');
    const [unknown] = bot.queueVisibleBatch('unknown', [
      { text: 'unrecognized report', discoveryIds: ['unknown-report'] },
    ]);
    bot.delivered(unknown);
    user('unlinked-user', '普通聊天');
    user('reply', '这类线上活动以后不用提醒我');
    bot.linkDiscoveryFeedback('reply', sent);
    assert.throws(() => bot.linkDiscoveryFeedback('reply', queued), /delivered discovery/);
    controller.refreshNotebook();
    controller.refreshNotebook();
    assert.equal(controller.notebook.events('delivery').length, 1);
    assert.equal(controller.notebook.feedback().length, 1);
    assert.equal(controller.notebook.topics().size, 0, 'receipt is not fabricated research');
    assert.equal(controller.notebook.event(`delivery:${sent}`).at, bot.discoveryDeliveries()[0].at);
    const text = controller.notebook.render();
    assert.match(text, /高频发现已发送的消息/);
    assert.match(text, /今晚活动改为线上，可以在家参加/);
    assert.match(text, /这类线上活动以后不用提醒我/);
    assert.doesNotMatch(
      text,
      /internal investigation|filtered candidate|transport has not|ordinary conversation|unrecognized report|普通聊天/,
    );
    controller.notebook.close();
    controller = new InitiativeController(ctx, store, {});
    // Replacing worker Sessions must not erase delivery or feedback memory.
    store.update((s) => {
      s.discoverySession = 'new-discovery';
      s.judgementSession = 'new-judgement';
    });
    controller.refreshNotebook();
    assert.equal(controller.notebook.render(), text);
    const feedback = controller.notebook.pendingFeedback()[0];
    controller.notebook.commitDraft({
      role: 'judgement',
      operationId: 'understand',
      expectedFeedbackRevision: controller.notebook.revision(),
      draft: {
        notes: [],
        messages: [],
        feedbackDecisions: [
          {
            feedbackId: feedback.id,
            understanding: '用户不希望再收到线上活动提醒',
            rules: [
              {
                quote: '这类线上活动以后不用提醒我',
                status: 'closed',
                reason: '用户明确要求',
                topicIds: [],
                tags: ['online-events'],
                resumeAt: null,
              },
            ],
          },
        ],
      },
    });
    controller.notebook.appendNote(
      { ...note, topicId: 'online', tags: ['online-events'] },
      'later-note',
    );
    assert.equal(
      controller.notebook.state('online').status,
      'closed',
      'feedback can govern future topics without a fabricated original topic',
    );
    // Older releases already imported mixed low/quick receipts via their low
    // topic. Replaying them must retain the append-only payload unchanged.
    controller.notebook.put('prepared-low', 'prepared', { topicIds: ['online'] });
    post('prepared-low', 'low report');
    const [mixed] = bot.queueVisibleBatch('mixed', [
      { text: 'combined delivery', discoveryIds: ['prepared-low', 'quick:round:report:0'] },
    ]);
    bot.delivered(mixed);
    const receipt = bot.discoveryDeliveries().find((m) => m.messageId === mixed)!;
    controller.notebook.put(
      `delivery:${mixed}`,
      'delivery',
      {
        text: receipt.text,
        topicIds: ['online'],
        messageIds: [mixed],
        preparedIds: receipt.discoveryIds,
        transport: 'assistant-bot',
      },
      receipt.at,
    );
    controller.refreshNotebook();
    assert.equal(controller.notebook.events('delivery').length, 2);
    assert.equal(controller.notebook.render().split('combined delivery').length - 1, 1);
  } finally {
    controller.notebook.close();
    store.release();
    store.close();
    bot.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('actual quick SendUser and user feedback are readable by all three workers without copying ordinary chat', async () => {
  const f = await fixture();
  const text = '周末摄影展改到下午了，可以避开早上的安排。';
  let sentId = '',
    quickRuns = 0,
    lowRuns = 0;
  try {
    await f.remote('assistant.bind', { sessionId: 'owner' });
    f.setRunner(async ({ prompt, invoke }: any) => {
      if (prompt.startsWith('Inbox 有新消息')) {
        const batch = await invoke('InboxCheck', {});
        for (const item of batch.items) {
          if (item.type === 'discovery') {
            await invoke('SendUser', {
              messageId: 'quick-sent',
              messages: [{ text, discoveryIds: [item.id] }],
            });
            sentId = f.workers.get('owner').transcript.find((m: any) => m.text === text).id;
          } else if (item.id === 'reply') {
            await invoke('DiscoveryFeedback', { userMessageId: 'reply', messageId: sentId });
          }
        }
        await invoke('Sleep', {});
      } else if (prompt.includes('Phase:')) {
        lowRuns++;
        const book = await readFile(view(prompt), 'utf8');
        assert.match(book, /周末摄影展改到下午/);
        assert.match(book, /下次还是可以告诉我/);
        assert.doesNotMatch(book, /今天中午吃面/);
        // Judgement acknowledges the linked feedback without inventing a topic.
        const feedbackId = book.match(/(feedback:\[[^\n]+?\])｜待理解/)?.[1];
        await output(prompt, {
          feedbackDecisions:
            prompt.includes('Phase: judgement') && feedbackId
              ? [{ feedbackId, understanding: '用户仍愿意收到相关消息', rules: [] }]
              : [],
        });
      } else {
        quickRuns++;
        const book = await invoke('QuickDiscoveryNotebook', {});
        if (quickRuns === 1) {
          assert.doesNotMatch(book.text, /周末摄影展改到下午/);
          await invoke('QuickDiscoveryReport', { key: 'photo', messages: [text] });
        } else {
          assert.match(book.text, /周末摄影展改到下午/);
          assert.match(book.text, /下次还是可以告诉我/);
          assert.doesNotMatch(book.text, /今天中午吃面/);
        }
      }
    });
    await f.remote('assistant.quick-discovery', { action: 'check' });
    await until(
      async () =>
        sentId &&
        !(await f.remote('assistant.quick-discovery-status', {})).active &&
        (await f.remote('assistant.binding')).bot.sleeping,
    );
    await f.send('ordinary', '今天中午吃面');
    await until(async () => (await f.remote('assistant.binding')).bot.sleeping);
    await f.send('reply', '下次还是可以告诉我');
    await until(async () => (await f.remote('assistant.binding')).bot.sleeping);
    await f.remote('assistant.quick-discovery', { action: 'check' });
    await until(
      async () =>
        quickRuns === 2 && !(await f.remote('assistant.quick-discovery-status', {})).active,
    );
    await f.invoke('InitiativeControl', { action: 'check' });
    await until(async () => lowRuns === 2 && !(await f.invoke('InitiativeStatus')).active);
    assert.equal((await f.invoke('InitiativeStatus')).lastError, null);
    assert.equal((await f.remote('assistant.quick-discovery-status', {})).lastError, null);
    assert.equal(f.workers.get('owner').transcript.filter((m: any) => m.text === text).length, 1);
  } finally {
    await f.close();
  }
});
