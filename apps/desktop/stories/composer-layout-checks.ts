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

import { expect } from 'storybook/test';

/** Browser geometry contract for the production toolbar, in every host.
 * Check hit areas and sibling overlap as well as scrollWidth: overlapping
 * controls can fit inside the card's scrollable bounds. */
export function expectComposerToolbar(card: HTMLElement) {
  const leading = card.querySelector<HTMLElement>('.maka-composer-footer-leading')!;
  const send = card.querySelector<HTMLElement>('button[type="submit"], button:has(svg.lucide-square)')!;
  const sendBox = send.getBoundingClientRect();
  const cardBox = card.getBoundingClientRect();
  const center = (sendBox.top + sendBox.bottom) / 2;
  const controls = [...new Set([...leading.querySelectorAll<HTMLElement>('button')]
    .filter(button => !button.closest('[role="menu"], [role="listbox"]'))
    .map(button => button.closest<HTMLElement>('.maka-composer-selector') ?? button))]
    .map(control => control.getBoundingClientRect())
    .filter(box => box.width > 0 && box.height > 0)
    .sort((a, b) => a.left - b.left);
  expect(sendBox.left).toBeGreaterThanOrEqual(cardBox.left);
  expect(sendBox.right).toBeLessThanOrEqual(cardBox.right);
  for (const [index, box] of controls.entries()) {
    expect(box.width).toBeGreaterThanOrEqual(28);
    expect(box.height).toBeLessThanOrEqual(32);
    expect(Math.abs((box.top + box.bottom) / 2 - center)).toBeLessThan(1);
    expect(box.left).toBeGreaterThanOrEqual(cardBox.left);
    expect(box.right).toBeLessThanOrEqual(sendBox.left);
    if (index > 0) expect(box.left).toBeGreaterThanOrEqual(controls[index - 1]!.right - 0.5);
  }
}

/** Exercise the supported interval and both sides of the presentation/query
 * boundaries. CSS resolves synchronously on a geometry read: no observer,
 * React update or arbitrary settle timeout is part of the layout contract. */
export function sweepComposerToolbar(card: HTMLElement) {
  const previousMaxWidth = card.style.maxWidth;
  const widths = Array.from({ length: 57 }, (_, index) => 800 - index * 8);
  widths.push(641, 640, 639, 401, 400, 399);
  const controls = [...card.querySelectorAll('[data-composer-selector-trigger]')];
  try {
    for (const width of [...widths, ...widths.toReversed()]) {
      card.style.maxWidth = `${width}px`;
      expectComposerToolbar(card);
      // Responsive presentation must not replace the interactive elements.
      expect([...card.querySelectorAll('[data-composer-selector-trigger]')]).toEqual(controls);
    }
  } finally {
    card.style.maxWidth = previousMaxWidth;
  }
}
