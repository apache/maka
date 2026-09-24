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
import { test } from 'node:test';
import { readFile, rm } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import {
  ClientPluginRuntime,
  MakaClientRoot,
  MakaClientRootOutlet,
  MakaClientSlotOutlet,
} from '../.artifacts/ui-api.mjs';
import { fixture, sleep, until } from './platform-helper.js';
test('long-task panel shows progress and creates an isolated follow-up conversation', async () => {
  const f = await fixture();
  const { window } = parseHTML('<html><head></head><body><div id="root"></div></body></html>');
  const globals = ['window', 'document', 'navigator', 'HTMLElement', 'IS_REACT_ACT_ENVIRONMENT'];
  const saved = globals.map((k) => [k, Object.getOwnPropertyDescriptor(globalThis, k)] as const);
  for (const [k, v] of Object.entries({
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
  }))
    Object.defineProperty(globalThis, k, {
      value: v,
      writable: true,
      configurable: true,
    });
  const root = new MakaClientRoot();
  const sent: Array<{ sessionId: string; text: string }> = [];
  (window as any).maka = {
    sessions: {
      create: async () => ({ id: 'dialog-session' }),
      send: async (sessionId: string, command: any) => {
        sent.push({ sessionId, text: command.text });
        return { ok: true, turnId: command.turnId };
      },
      readSnapshot: async () => ({ items: [] }),
    },
  };
  const streams = new Map<string, any>();
  let nextId = 0;
  let runtime: any;
  let reactRoot: any;
  try {
    const view = await f.invoke('MatterStart', {
      title: '面板测试',
      request: '持续跟进',
    });
    await f.invoke('MatterWriteFile', {
      path: view.files.draft,
      content: '状态：等待外部结果。',
    });
    await f.invoke('MatterSettle', {
      expectedRevision: view.revision,
      stateFile: view.files.draft,
      disposition: 'wait',
      wakes: [{ kind: 'at', at: Date.now() + 60000 }],
      summary: '已检查',
      reason: '等待',
      next: '检查审核结果，通过后安排验收会议。',
      update: '开始跟进',
    });
    f.driver.end();
    await until(async () => !(await f.remote('matters.list')).matters[0].activation);
    const snapshot = await f.platform.clientSnapshot();
    const bundle = await readFile('dist/client.js', 'utf8');
    runtime = new ClientPluginRuntime({
      root,
      document: window.document,
      staticModules: { react: React },
      loadBundle: async () =>
        runInNewContext(bundle, {
          window: Object.assign(window, { __MakaModuleLoader__: runtime.loader }),
          AbortController,
        }),
      remote: {
        call: async (input: any) => ({
          value: await f.platform.invokeClientRemote(input),
        }),
        open: async (input: any) => {
          const binding = await f.platform.openClientRemoteStream(input);
          const streamId = String(++nextId);
          streams.set(streamId, binding);
          return { streamId };
        },
        next: async ({ streamId }: any) => streams.get(streamId).next(),
        close: async ({ streamId }: any) => {
          await streams.get(streamId)?.close();
          streams.delete(streamId);
        },
      },
      productEvents: { subscribe: () => () => {} },
    });
    await runtime.reconcile({
      ...snapshot,
      plugins: snapshot.entries.map((e: any) => ({
        ...e,
        url: 'https://fixture.invalid/client.js',
      })),
    });
    assert.equal(runtime.inspect().failure, null);
    reactRoot = createRoot(window.document.getElementById('root')!);
    await React.act(async () =>
      reactRoot.render(
        React.createElement(
          MakaClientRootOutlet,
          { root },
          React.createElement(MakaClientSlotOutlet, {
            name: 'sidebar.footer',
            owner: {},
          }),
          React.createElement(MakaClientSlotOutlet, {
            name: 'shell.overlay',
            owner: {},
          }),
        ),
      ),
    );
    const click = async (label: string) => {
      const button = [...window.document.querySelectorAll('button')].find(
        (b: any) => b.textContent === label || b.getAttribute('aria-label') === label,
      );
      assert.ok(button, label);
      await React.act(async () => {
        button!.dispatchEvent(new window.Event('click', { bubbles: true }));
        await sleep(60);
      });
    };
    await click('长任务');
    assert.match(window.document.head.textContent!, /left:auto;right:24px;top:88px/);
    assert.match(window.document.body.textContent!, /面板测试/);
    assert.match(window.document.body.textContent!, /下次检查/);
    assert.doesNotMatch(window.document.body.textContent!, /状态：等待外部结果/);
    await click('查看任务：面板测试');
    assert.match(window.document.body.textContent!, /已经做了什么/);
    assert.match(window.document.body.textContent!, /已检查/);
    assert.match(window.document.body.textContent!, /检查审核结果，通过后安排验收会议/);
    assert.equal(window.document.querySelectorAll('textarea').length, 1);
    assert.ok(
      ![...window.document.querySelectorAll('button')].some((b) =>
        ['暂停', '更多', '聊这个任务', '现在检查', '结束跟进'].includes(b.textContent || ''),
      ),
    );
    assert.equal((await f.remote('matters.list')).matters[0].status, 'waiting');
    await click('返回列表');
    assert.doesNotMatch(window.document.body.textContent!, /已经做了什么/);
    await click('查看任务：面板测试');
    // External state changes still arrive through the real stream; the panel does not mutate state.
    await React.act(async () => {
      await f.invoke('MatterControl', { action: 'pause' }, 'human-pause-turn');
      await sleep(1100);
    });
    assert.match(window.document.body.textContent!, /任务已暂停/);
    await click('收起长任务');
    assert.equal(window.document.querySelectorAll('.mt-card').length, 0);
    await click('长任务');
    await click('返回列表');
    const input = window.document.querySelector('textarea')!;
    await React.act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!.call(input, '明天检查评审状态');
      input.dispatchEvent(new window.Event('input', { bubbles: true }));
      await sleep(20);
    });
    const form = window.document.querySelector('.mt-compose')!;
    await React.act(async () => {
      form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
      await sleep(60);
    });
    assert.deepEqual(sent, [{ sessionId: 'dialog-session', text: '明天检查评审状态' }]);
    const pending = f.tools.resolve('dialog-session', []).tools.find((t: any) => t.name === 'MatterStart');
    assert.ok(pending);
    // Only a session authorized by the dialog may enroll; ordinary conversations stay ordinary.
    await assert.rejects(() => pending.impl({ title: '普通聊天', request: '持续跟进' }, {
      sessionId: 'ordinary-session', turnId: 'ordinary-turn', toolCallId: 'ordinary-call',
      cwd: f.root, abortSignal: new AbortController().signal, permissionMode: 'default',
    }), /long-task dialog/);
    // Stale generation fences are checked by the real Host, not mocked by the Client.
    const descriptor = snapshot.entries[0];
    await assert.rejects(() =>
      f.platform.invokeClientRemote({
        ...descriptor,
        authorityEpoch: snapshot.authorityEpoch,
        revision: snapshot.revision,
        generation: 999,
        method: 'matters.list',
        input: {},
      }),
    );
    await React.act(async () => {
      await runtime.close();
      reactRoot.unmount();
    });
    assert.equal(window.document.querySelectorAll('style').length, 0);
  } finally {
    await runtime?.close();
    await f.close();
    await rm(f.root, { recursive: true, force: true });
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as any)[key];
    }
  }
});
