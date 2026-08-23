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
import { parseHTML } from 'linkedom';
import { captureChatScrollAnchor, restoreChatScrollAnchor } from '../chat-scroll-anchor.js';

test('reuses the visible article while virtual history changes above it', () => {
  const { document } = parseHTML('<main id="root"></main>');
  const root = document.querySelector<HTMLElement>('#root')!;
  Object.defineProperty(root, 'scrollTop', { value: 0, writable: true });
  root.getBoundingClientRect = () => ({ top: 100 }) as DOMRect;
  let rectReads = 0;
  for (let index = 0; index < 200; index += 1) {
    const turn = document.createElement('section');
    turn.dataset.turnId = `turn-${index}`;
    const article = document.createElement('article');
    article.dataset.sender = 'assistant';
    article.getBoundingClientRect = () => {
      rectReads += 1;
      return { top: index < 180 ? 0 : 120, bottom: index < 180 ? 80 : 160 } as DOMRect;
    };
    turn.append(article);
    root.append(turn);
  }

  const first = captureChatScrollAnchor(root);
  assert.equal(first?.turnId, 'turn-180');
  rectReads = 0;
  const second = captureChatScrollAnchor(root);
  assert.equal(second?.turnId, 'turn-180');
  assert.ok(rectReads <= 4);
  assert.equal(restoreChatScrollAnchor(root, second), true);
});

test('skips message descendants while advancing the cached anchor', () => {
  const { document } = parseHTML('<main id="root"></main>');
  const root = document.querySelector<HTMLElement>('#root')!;
  Object.defineProperty(root, 'scrollTop', { value: 0, writable: true });
  root.getBoundingClientRect = () => ({ top: 100 }) as DOMRect;

  const first = document.createElement('article');
  first.dataset.sender = 'assistant';
  first.getBoundingClientRect = () => ({ top: 120, bottom: 160 }) as DOMRect;
  let parent = first;
  let descendantReads = 0;
  for (let index = 0; index < 1_000; index += 1) {
    const child = document.createElement('div');
    parent.append(child);
    const current = parent;
    const nested = child;
    Object.defineProperty(current, 'firstElementChild', {
      configurable: true,
      get() {
        descendantReads += 1;
        return nested;
      },
    });
    parent = child;
  }
  const second = document.createElement('article');
  second.dataset.sender = 'assistant';
  second.getBoundingClientRect = () => ({ top: 120, bottom: 160 }) as DOMRect;
  const firstTurn = document.createElement('section');
  firstTurn.dataset.turnId = 'turn-1';
  firstTurn.append(first);
  const secondTurn = document.createElement('section');
  secondTurn.dataset.turnId = 'turn-2';
  secondTurn.append(second);
  root.append(firstTurn, secondTurn);

  assert.equal(captureChatScrollAnchor(root)?.turnId, 'turn-1');
  first.getBoundingClientRect = () => ({ top: 0, bottom: 80 }) as DOMRect;
  assert.equal(captureChatScrollAnchor(root)?.turnId, 'turn-2');
  assert.equal(descendantReads, 0);
});
