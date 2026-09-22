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
    let origin: Element | null | undefined;
    await act(async () => {
      root.render(
        createElement(LocaleProvider, {
          locale: 'zh-CN',
          children: createElement(ParentTaskStatusNotice, {
            status: 'last_turn_failed',
            onOpenParentConversation: (element) => {
              opened += 1;
              origin = element;
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
    click(button, button);
    assert.equal(opened, 1);
    assert.equal(origin, button, 'the action hands its own workspace frame to the focus owner');
  });

  it('renders one polite live region per notice', async () => {
    const { root, container } = installReactRenderer();
    const notice = () =>
      createElement(LocaleProvider, {
        locale: 'en',
        children: createElement(ParentTaskStatusNotice, { status: 'waiting_approval' }),
      });
    await act(async () => {
      root.render(notice());
    });
    const live = findByRole(container, 'status');
    assert.ok(live, 'a status live region is missing');
    assert.equal(live.attributes.get('aria-live'), 'polite');
    assert.equal(live.textContent, 'Parent task is waiting for approval; approve it in the parent conversation');
    assert.equal(
      countByRole(container, 'status'),
      1,
      'each notice owns exactly one live region; a second notice announces separately',
    );
  });
});

function findByRole(
  node: { childNodes: readonly unknown[]; attributes?: Map<string, string>; textContent?: string },
  role: string,
): { attributes: Map<string, string>; textContent: string } | undefined {
  if (node.attributes?.get('role') === role) {
    return node as { attributes: Map<string, string>; textContent: string };
  }
  for (const child of node.childNodes) {
    if (child && typeof child === 'object' && 'childNodes' in child) {
      const found = findByRole(
        child as { childNodes: readonly unknown[]; attributes?: Map<string, string> },
        role,
      );
      if (found) return found;
    }
  }
  return undefined;
}

function countByRole(
  node: { childNodes: readonly unknown[]; attributes?: Map<string, string> },
  role: string,
): number {
  let count = node.attributes?.get('role') === role ? 1 : 0;
  for (const child of node.childNodes) {
    if (child && typeof child === 'object' && 'childNodes' in child) {
      count += countByRole(
        child as { childNodes: readonly unknown[]; attributes?: Map<string, string> },
        role,
      );
    }
  }
  return count;
}

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

function click(node: object, currentTarget?: unknown) {
  const event = { preventDefault() {}, stopPropagation() {}, currentTarget };
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
