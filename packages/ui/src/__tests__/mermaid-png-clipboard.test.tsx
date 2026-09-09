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
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { LocaleProvider } from '../locale-context.js';
import { MermaidDiagram } from '../mermaid-diagram.js';
import { installDom, settleEffects } from './mermaid-test-dom.js';

const BACKGROUND = 'rgb(24, 32, 48)';

for (const expanded of [false, true]) {
  for (const failure of ['none', 'decode', 'toBlob-null', 'toBlob-throw', 'write'] as const) {
    test(`copies PNG from ${expanded ? 'fullscreen' : 'inline'} toolbar: ${failure}`, async (t) => {
      const dom = installDom();
      t.after(() => dom.restore());
      const createElement = dom.document.createElement.bind(dom.document);
      t.mock.method(dom.document, 'createElement', (name: string, options?: ElementCreationOptions) => {
        const element = createElement(name, options);
        if (name === 'dialog') {
          Object.assign(element, {
            showModal() { element.setAttribute('open', ''); },
            close() { element.removeAttribute('open'); },
          });
        }
        return element;
      });
      const mermaid = (await import('mermaid')).default;
      t.mock.method(mermaid, 'initialize', () => {});
      t.mock.method(mermaid, 'render', async (id: string) => ({
        diagramType: 'flowchart-v2',
        svg: `<svg id="${id}" viewBox="0 0 123 45" width="100%" style="max-width:123px"><rect width="10" height="10" /></svg>`,
      }));

      const calls: string[] = [];
      const images: TestImage[] = [];
      class TestImage {
        src = '';
        constructor() { images.push(this); }
        async decode() {
          calls.push('decode');
          if (failure === 'decode') throw new Error('decode rejected');
        }
      }
      class TestClipboardItem {
        constructor(readonly data: Record<string, Blob>) {}
      }
      for (const [key, value] of Object.entries({ Image: TestImage, ClipboardItem: TestClipboardItem })) {
        const original = Object.getOwnPropertyDescriptor(globalThis, key);
        Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
        t.after(() => {
          if (original) Object.defineProperty(globalThis, key, original);
          else Reflect.deleteProperty(globalThis, key);
        });
      }

      const originalComputedStyle = globalThis.getComputedStyle;
      t.mock.method(globalThis, 'getComputedStyle', (element: Element) => ({
        ...originalComputedStyle(element),
        backgroundColor: element.tagName === 'FIGURE' ? BACKGROUND : 'transparent',
      }));
      const blob = new Blob(['test PNG bytes'], { type: 'image/png' });
      const writes: TestClipboardItem[][] = [];
      Object.defineProperty(globalThis, 'navigator', {
        configurable: true,
        value: {
          clipboard: {
            async write(items: TestClipboardItem[]) {
              calls.push('write');
              writes.push(items);
              if (failure === 'write') throw new Error('clipboard rejected');
            },
          },
        },
      });
      const canvases: HTMLCanvasElement[] = [];
      const paints: unknown[][] = [];
      const context = {
        fillStyle: '',
        fillRect(...args: number[]) {
          calls.push('fill');
          paints.push([this.fillStyle, ...args]);
        },
        drawImage(...args: unknown[]) {
          calls.push('draw');
          paints.push(args);
        },
      };
      t.mock.method(dom.document.defaultView!.HTMLCanvasElement.prototype, 'getContext', function (this: HTMLCanvasElement, kind: string) {
        assert.equal(kind, '2d');
        canvases.push(this);
        return context;
      });
      // linkedom does not provide toBlob, so install and restore the descriptor.
      const canvasPrototype = dom.document.defaultView!.HTMLCanvasElement.prototype;
      const originalToBlob = Object.getOwnPropertyDescriptor(canvasPrototype, 'toBlob');
      Object.defineProperty(canvasPrototype, 'toBlob', {
        configurable: true,
        value(callback: BlobCallback, mime: string) {
          calls.push('toBlob');
          assert.equal(mime, 'image/png');
          if (failure === 'toBlob-throw') throw new Error('canvas export rejected');
          callback(failure === 'toBlob-null' ? null : blob);
        },
      });
      t.after(() => {
        if (originalToBlob) Object.defineProperty(canvasPrototype, 'toBlob', originalToBlob);
        else Reflect.deleteProperty(canvasPrototype, 'toBlob');
      });

      const root = createRoot(dom.document.querySelector('#root')!);
      try {
        await act(async () => root.render(
          <LocaleProvider locale="en">
            <MermaidDiagram code={`flowchart LR\n${expanded}_${failure} --> b`} density="default" />
          </LocaleProvider>,
        ));
        await settleEffects();
        const click = async (selector: string) => {
          const button = dom.document.querySelector<HTMLButtonElement>(selector);
          assert.ok(button, `expected rendered button: ${selector}`);
          await act(async () => button.click());
          await settleEffects();
        };
        if (expanded) await click('button[aria-label="View diagram fullscreen"]');
        const figure = expanded ? 'figure.maka-mermaid-diagram-expanded' : 'figure:not(.maka-mermaid-diagram-expanded)';
        await click(`${figure} button[aria-label="Copy diagram"]`);

        assert.equal(images.length, 1);
        assert.match(images[0]!.src, /^data:image\/svg\+xml;charset=utf-8,/);
        const svg = decodeURIComponent(images[0]!.src.split(',')[1]!);
        assert.match(svg, /^<svg width="123" height="45"/);
        assert.doesNotMatch(svg, /width="100%"/);
        if (failure === 'decode') {
          assert.deepEqual(calls, ['decode']);
          assert.equal(canvases.length, 0);
        } else {
          assert.equal(canvases.length, 1);
          assert.equal(canvases[0]!.width, 246);
          assert.equal(canvases[0]!.height, 90);
          assert.deepEqual(paints, [[BACKGROUND, 0, 0, 246, 90], [images[0], 0, 0, 246, 90]]);
          assert.deepEqual(calls, ['decode', 'fill', 'draw', 'toBlob', ...(['none', 'write'].includes(failure) ? ['write'] : [])]);
        }
        if (failure === 'none' || failure === 'write') {
          assert.equal(writes.length, 1);
          assert.equal(writes[0]!.length, 1);
          const item = writes[0]![0]!;
          assert.ok(item instanceof TestClipboardItem);
          assert.deepEqual(Object.keys(item.data), ['image/png']);
          assert.equal(item.data['image/png'], blob);
          assert.equal(item.data['image/png']!.type, 'image/png');
        } else {
          assert.equal(writes.length, 0);
        }
        if (failure === 'none') {
          assert.ok(dom.document.querySelector(`${figure} button[aria-label="Copy diagram"] .lucide-check`));
          assert.equal(dom.document.querySelector('button[aria-label="Copy diagram failed"]'), null);
        } else {
          assert.ok(dom.document.querySelector(`${figure} button[aria-label="Copy diagram failed"]`));
          assert.equal(dom.document.querySelector(`${figure} .lucide-check`), null);
        }
      } finally {
        await act(async () => root.unmount());
        t.mock.restoreAll();
      }
    });
  }
}
