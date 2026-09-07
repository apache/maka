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
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { usePendingSelection } from '../use-pending-selection.js';

interface Deferred {
  resolve(): void;
  reject(): void;
}

interface Harness {
  value(): string;
  pick(next: string): Promise<void>;
  render(authoritative: string): Promise<void>;
  settle(index?: number): Promise<void>;
  reject(index?: number): Promise<void>;
}

const flush = () => new Promise((r) => setTimeout(r, 0));

async function mount(initial: string): Promise<Harness> {
  const { document, window } = parseHTML('<div id="root"></div>');
  Object.assign(globalThis, {
    document,
    window,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const container = document.querySelector('#root');
  assert.ok(container);

  const writes: Deferred[] = [];
  let handle: { value: string; onChange: (n: string) => void } | null = null;
  const onValueChange = (_next: string) =>
    new Promise<void>((resolve, reject) => {
      writes.push({ resolve, reject });
    });

  function Host({ authoritative }: { authoritative: string }) {
    handle = usePendingSelection(authoritative, onValueChange);
    return null;
  }

  const root = createRoot(container as unknown as Element);
  await act(() => {
    root.render(createElement(Host, { authoritative: initial }));
  });

  return {
    value: () => handle!.value,
    pick: async (next) => {
      await act(async () => {
        handle!.onChange(next);
        await flush();
      });
    },
    render: async (authoritative) => {
      await act(() => {
        root.render(createElement(Host, { authoritative }));
      });
    },
    settle: async (index = writes.length - 1) => {
      await act(async () => {
        writes[index]!.resolve();
        await flush();
      });
    },
    reject: async (index = writes.length - 1) => {
      await act(async () => {
        writes[index]!.reject();
        await flush();
      });
    },
  };
}

test('a pick shows immediately, before the write settles', async () => {
  const h = await mount('A');
  assert.equal(h.value(), 'A');
  await h.pick('B');
  assert.equal(h.value(), 'B');
});

test('the pick clears to authority once the write resolves and value catches up', async () => {
  const h = await mount('A');
  await h.pick('B');
  await h.render('B'); // caller's refresh lands the new authority
  await h.settle();
  assert.equal(h.value(), 'B');
});

test('a rejected write rolls back to the authoritative value', async () => {
  const h = await mount('A');
  await h.pick('B');
  assert.equal(h.value(), 'B');
  await h.reject();
  assert.equal(h.value(), 'A');
});

test('the pick holds across an unrelated authority change while the write is in flight', async () => {
  const h = await mount('A');
  await h.pick('B');
  // An unrelated event pushes a different authoritative value mid-write; the
  // user's pick still shows until their own write settles.
  await h.render('C');
  assert.equal(h.value(), 'B');
  await h.settle();
  assert.equal(h.value(), 'C');
});

test('latest pick wins: a slower earlier write settling does not wipe a newer pick', async () => {
  const h = await mount('A');
  await h.pick('B'); // write #0
  await h.pick('C'); // write #1 (newer)
  assert.equal(h.value(), 'C');
  await h.settle(0); // the older B write resolves late
  assert.equal(h.value(), 'C'); // still C, not cleared
  await h.render('C');
  await h.settle(1);
  assert.equal(h.value(), 'C');
});
