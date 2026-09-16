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

import { strict as assert } from 'node:assert';
import { afterEach, describe, it } from 'node:test';
import { act, createElement } from 'react';
import { LocaleProvider } from '@maka/ui';
import { cleanupFakeDom, installReactRenderer } from './fake-dom.js';
import {
  ParentTaskStatusNotice,
} from '../../renderer/features/workbar/testing.js';

describe('ParentTaskStatusNotice', () => {
  afterEach(() => {
    cleanupFakeDom();
    delete (globalThis as { window?: unknown }).window;
  });

  it('shows the latest-turn failure and the parent conversation action', async () => {
    const { root, container } = installReactRenderer();
    let opened = 0;
    await act(async () => {
      root.render(
        createElement(LocaleProvider, {
          locale: 'zh-CN',
          children: createElement(ParentTaskStatusNotice, {
            status: 'last_turn_failed',
            onOpenParentConversation: () => {
              opened += 1;
            },
          }),
        }),
      );
    });
    const text = container.textContent;
    assert.match(text, /主任务最近一轮失败/);
    assert.match(text, /前往主对话/);
    const notice = findByContract(container, 'side-chat-parent-status');
    assert.equal(notice?.attributes.get('data-status'), 'last_turn_failed');
    const button = findButton(container);
    assert.ok(button, 'parent conversation action is missing');
    click(button);
    assert.equal(opened, 1);
  });
});

function findByContract(node: { childNodes: readonly unknown[]; attributes?: Map<string, string> }, value: string): { attributes: Map<string, string>; childNodes: readonly unknown[] } | undefined {
  if (node.attributes?.get('data-maka-contract') === value) {
    return node as { attributes: Map<string, string>; childNodes: readonly unknown[] };
  }
  for (const child of node.childNodes) {
    if (child && typeof child === 'object' && 'childNodes' in child) {
      const found = findByContract(child as { childNodes: readonly unknown[]; attributes?: Map<string, string> }, value);
      if (found) return found;
    }
  }
  return undefined;
}

function findButton(node: { childNodes?: readonly unknown[]; tagName?: string; onclick?: unknown; props?: unknown }): { click?: () => void; onclick?: () => void } | undefined {
  if (node.tagName === 'BUTTON') return node as { click?: () => void; onclick?: () => void };
  for (const child of node.childNodes ?? []) {
    if (child && typeof child === 'object') {
      const found = findButton(child as { childNodes?: readonly unknown[]; tagName?: string });
      if (found) return found;
    }
  }
  return undefined;
}

function click(node: object) {
  const event = { preventDefault() {}, stopPropagation() {} };
  const reactProps = Object.entries(node).find(([key]) => key.startsWith('__reactProps$'))?.[1] as
    | { onClick?: (event: unknown) => void }
    | undefined;
  if (typeof reactProps?.onClick === 'function') {
    reactProps.onClick(event);
    return;
  }
  const host = node as { click?: () => void; onclick?: (event: unknown) => void; onClick?: (event: unknown) => void };
  if (typeof host.onClick === 'function') {
    host.onClick(event);
    return;
  }
  if (typeof host.onclick === 'function' && host.onclick.name !== 'noop$1') {
    host.onclick(event);
    return;
  }
  host.click?.();
}
