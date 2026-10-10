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
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import {
  ClientPluginRuntime,
  MakaClientRoot,
  MakaClientRootOutlet,
  MakaClientPluginSdkModule,
  MakaClientSlotOutlet,
} from '../.artifacts/ui-api.mjs';

// Actual shipped Client, with a controlled transport: no real accounts or imports.
test('assistant entry opens one Host-qualified native conversation; never renders another composer', async () => {
  const { window } = parseHTML('<html><head></head><body><div id="root"></div></body></html>');
  const keys = ['window', 'document', 'navigator', 'HTMLElement', 'IS_REACT_ACT_ENVIRONMENT'];
  const saved = keys.map((k) => [k, Object.getOwnPropertyDescriptor(globalThis, k)] as const);
  for (const [k, v] of Object.entries({
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
  }))
    Object.defineProperty(globalThis, k, { value: v, writable: true, configurable: true });
  window.matchMedia = () =>
    ({
      matches: false,
      addListener() {},
      removeListener() {},
      addEventListener() {},
      removeEventListener() {},
    }) as any;
  let state: any = null,
    created = 0,
    runtime: any,
    root: any,
    f: any;
  let items: any[] = [];
  const opened: string[] = [],
    calls: string[] = [];
  const ownerId = JSON.stringify(['host-one', 'assistant']);
  (window as any).maka = {
    runtimeHostProfiles: { getDefaultHost: async () => ({ hostId: 'host-one' }) },
    sessions: {
      create: async () => {
        created++;
        return { id: ownerId };
      },
      list: async () => [{ id: JSON.stringify(['host-two', 'assistant']) }, { id: ownerId }],
    },
  };
  const slots = new MakaClientRoot();
  try {
    const bundle = await readFile('../index-initiative/dist/client.js', 'utf8');
    // Use real client runtime packaging metadata obtained from the plugin's existing test platform.
    // The Host side below is intentionally a controlled transport for UI interaction assertions.
    const { fixture } = await import('../../index-initiative/test/fixture.js');
    const cwd = process.cwd();
    process.chdir('../index-initiative');
    try {
      f = await fixture();
    } finally {
      process.chdir(cwd);
    }
    const snapshot = await f.platform.clientSnapshot();
    runtime = new ClientPluginRuntime({
      root: slots,
      document: window.document,
      staticModules: { react: React, '@maka/ui/client-plugin': MakaClientPluginSdkModule },
      loadBundle: async () =>
        runInNewContext(bundle, {
          window: Object.assign(window, { __MakaModuleLoader__: runtime.loader }),
          AbortController,
          setTimeout,
          clearTimeout,
        }),
      remote: {
        call: async (input: any) => {
          calls.push(input.method);
          if (input.method === 'assistant.bind')
            state = {
              sessionId: 'assistant',
              enabled: false,
              intervalMs: 1800000,
              lastCheckedAt: null,
              nextAt: null,
            };
          if (input.method === 'assistant.control')
            state = {
              ...state,
              enabled: input.input.action !== 'pause',
              lastCheckedAt: Date.now(),
              nextAt: Date.now() + 1800000,
            };
          return {
            value:
              input.method === 'assistant.bind'
                ? state
                : input.method === 'assistant.binding'
                  ? { state }
                  : {
                      state,
                      memory: { installed: true, sources: [], indexes: [] },
                      tasks: { installed: true, items, legacy: [] },
                    },
          };
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
    root = createRoot(window.document.getElementById('root')!);
    await React.act(async () =>
      root.render(
        React.createElement(
          MakaClientRootOutlet,
          { root: slots },
          React.createElement(MakaClientSlotOutlet, {
            name: 'sidebar.navigation',
            owner: { collapsed: false, openSession: (id: string) => opened.push(id) },
          }),
          React.createElement(MakaClientSlotOutlet, { name: 'shell.overlay', owner: {} }),
        ),
      ),
    );
    const click = async (label: string) => {
      const button = [...window.document.querySelectorAll('button')].find(
        (b) => b.textContent === label || b.getAttribute('aria-label') === label,
      );
      assert.ok(button, label);
      await React.act(async () => {
        button.dispatchEvent(new window.Event('click', { bubbles: true }));
        await new Promise((r) => setTimeout(r, 60));
      });
    };
    await click('个人助手');
    assert.equal(created, 1);
    assert.deepEqual(opened, [ownerId]);
    await click('收起助手状态');
    await click('个人助手');
    assert.equal(created, 1);
    assert.deepEqual(opened, [ownerId, ownerId]);
    assert.equal(window.document.querySelectorAll('textarea').length, 0);
    assert.match(window.document.body.textContent!, /无需先导入|历史导入可选/);
    assert.ok(!calls.includes('assistant.control'), 'opening must not enable heartbeats');
    assert.equal(window.document.querySelector('.pa-settings'), null);
    assert.equal(window.document.querySelector('.pa-memory'), null);
    assert.equal(window.document.body.textContent!.includes('回到助手聊天'), false);
    await click('助手设置');
    assert.ok(window.document.querySelector('.pa-settings'));
    await click('开启并立即检查');
    assert.equal(state.enabled, true);
    await click('暂停主动发现');
    assert.equal(state.enabled, false);
    await click('助手设置');
    assert.equal(window.document.querySelector('.pa-settings'), null);
    items = [
      {
        id: 'waiting',
        title: '演示包验收',
        status: 'waiting',
        updates: [{ text: '导出已通过，等待隔离复测。' }],
        waitingFor: '等待构建结果',
        wakes: [{ at: Date.now() + 60000 }],
      },
      {
        id: 'done',
        title: '已签收',
        status: 'completed',
        updates: [],
        wakes: [{ at: Date.now() + 60000 }],
      },
    ];
    await click('记忆与来源');
    await click('刷新记忆状态');
    assert.ok(window.document.querySelector('.pa-memory'));
    await click('记忆与来源');
    assert.equal(window.document.querySelector('.pa-memory'), null);
    assert.match(window.document.body.textContent!, /导出已通过，等待隔离复测/);
    const done = window.document.querySelector('button[aria-label="查看任务：已签收"]')!;
    assert.ok(done.closest('details'), 'finished tasks stay in collapsed history');
    assert.doesNotMatch(
      done.textContent!,
      /下次/,
      'stale wakes on completed tasks must not appear',
    );
    await click('查看任务：演示包验收');
    assert.match(window.document.querySelector('.pa-detail')!.textContent!, /等待构建结果/);
    assert.match(window.document.querySelector('.pa-detail')!.textContent!, /下次检查/);
    await click('‹ 返回跟进列表');
    assert.equal(window.document.querySelector('.pa-detail'), null);
    assert.equal(created, 1, 'panel drilldown must not create another conversation');
    await React.act(async () => {
      await runtime.close();
      root.unmount();
    });
    root = undefined;
    runtime = undefined;
    assert.equal(window.document.querySelectorAll('style').length, 0);
  } finally {
    await React.act(async () => {
      await runtime?.close();
      root?.unmount();
    });
    await f?.close();
    for (const [key, descriptor] of saved)
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as any)[key];
  }
});
