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
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
const require = createRequire(import.meta.url);
const React = require('react');
const { createRoot } = require('react-dom/client');
const { parseHTML } = require('linkedom');

test('assistant entry reuses native chat, status is read-only, and settings live separately', async () => {
  const { window } = parseHTML('<html><body><div id="app"></div></body></html>');
  const saved = Object.getOwnPropertyDescriptors(globalThis);
  Object.assign(globalThis, { window, document: window.document, IS_REACT_ACT_ENVIRONMENT: true });
  const h = React.createElement;
  const slots = new Map<string, any>();
  const definitions = new Map<string, any>();
  const calls: string[] = [];
  let binding: any = null;
  let created = 0;
  let selected: string | undefined;
  const session = { id: JSON.stringify(['host-a', 'owner']), labels: ['personal-assistant'] };
  const status = () => ({
    state: binding && { ...binding, enabled: false, intervalMs: 1800000 },
    tasks: {
      installed: true,
      items: [
        {
          id: 't',
          title: '等待验收',
          status: 'waiting',
          waitingFor: '等待测试结果',
          wakes: [{ at: Date.now() + 60000 }],
        },
      ],
    },
    memory: { installed: true, sources: [], indexes: [] },
    sourceSync: { installed: true, schedule: { enabled: false } },
  });
  window.maka = {
    sessions: {
      list: async () => [session, { ...session, id: JSON.stringify(['other-host', 'owner']) }],
      create: async (args: any) => {
        created++;
        assert.deepEqual(Array.from(args.labels), ['personal-assistant']);
        return session;
      },
    },
    runtimeHostProfiles: { getDefaultHost: async () => ({ hostId: 'host-a' }) },
  };
  window.__MakaModuleLoader__ = {
    load: ({ factory }: any) =>
      factory((name: string) =>
        name === 'react'
          ? React
          : {
              SideNavItem: ({ label, onClick, isSelected }: any) =>
                h('button', { onClick, 'aria-current': isSelected ? 'page' : undefined }, label),
            },
      ).apply({
        slots: {
          register: (def: any, component: any) => {
            const key = def.name;
            slots.set(key, component);
            definitions.set(key, def);
          },
        },
        style: () => {},
        remote: {
          call: async (name: string) => {
            calls.push(name);
            if (name === 'assistant.binding') return { state: binding };
            if (name === 'assistant.bind') {
              binding = { sessionId: 'owner' };
              return binding;
            }
            if (name === 'assistant.status') return status();
            return {};
          },
        },
      }),
  };
  runInNewContext(readFileSync(new URL('../src/client.js', import.meta.url), 'utf8'), {
    window,
    setTimeout,
    clearTimeout,
  });
  const root = createRoot(window.document.getElementById('app'));
  const container = window.document.getElementById('app');
  const navigate = (id: string) => {
    selected = id;
  };
  const render = async (settings = false) =>
    React.act(async () => {
      root.render(
        h(
          React.Fragment,
          {},
          h(slots.get('sidebar.navigation'), { openSession: navigate, activeSessionId: selected }),
          h(slots.get('shell.overlay')),
          settings && h(slots.get('settings.page')),
        ),
      );
    });
  const click = async (text: string) => {
    const button = Array.from(container.querySelectorAll('button')).find(
      (b: any) => b.textContent === text,
    ) as any;
    assert.ok(button, text);
    await React.act(async () => button.dispatchEvent(new window.Event('click', { bubbles: true })));
  };
  try {
    assert.deepEqual(Array.from(definitions.get('sidebar.navigation').sessionLabels), [
      'personal-assistant',
    ]);
    assert.equal(definitions.get('settings.page').key, 'personal-assistant');
    await render();
    assert.equal(container.querySelector('aside'), null);
    await click('个人助手');
    await render();
    assert.equal(created, 1);
    assert.equal(selected, session.id);
    assert.ok(container.querySelector('[aria-current="page"]'));
    assert.match(container.querySelector('aside').textContent, /等待验收/);
    assert.equal(container.querySelector('aside input'), null);
    for (const text of ['开启并立即检查', '同步一次', '现在整理', '暂停任务', '核对并恢复']) {
      assert.ok(!container.querySelector('aside').textContent.includes(text));
    }
    await click('个人助手');
    await render();
    assert.equal(created, 1);
    selected = 'normal';
    await render();
    assert.equal(container.querySelector('aside'), null);
    assert.equal(container.querySelector('[aria-current="page"]'), null);
    await render(true);
    const settings = container.querySelector('[aria-label="个人助手设置"]');
    assert.ok(settings.querySelector('input'));
    assert.match(settings.textContent, /开启并立即检查/);
    assert.match(settings.textContent, /同步一次/);
    assert.equal(
      calls.filter((name) => name === 'assistant.control' || name === 'assistant.recover').length,
      0,
    );
    await click('开启并立即检查');
    assert.equal(calls.filter((name) => name === 'assistant.control').length, 1);
  } finally {
    await React.act(() => root.unmount());
    for (const key of ['window', 'document', 'IS_REACT_ACT_ENVIRONMENT']) {
      if (saved[key]) Object.defineProperty(globalThis, key, saved[key]!);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
