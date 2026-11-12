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
import { act, Profiler } from 'react';
import { createRoot } from 'react-dom/client';
import { installDom, settleEffects } from './mermaid-test-dom.js';
import { LocaleProvider } from '../locale-context.js';
import { MERMAID_RENDER_CACHE_LIMIT, MERMAID_RESIZE_SETTLE_MS, MermaidDiagram } from '../mermaid-diagram.js';

test('renders Pele templates with isolated references and retains them across theme changes and remounts', async () => {
  const dom = installDom();
  const code = 'flowchart LR\nsubgraph 服务\nA[开始<br/>第二行] --> B[完成]\nend';
  const view = () => <LocaleProvider locale="en">
    <MermaidDiagram code={code} density="default" />
    <MermaidDiagram code={code} density="compact" />
    <MermaidDiagram code={'sankey-beta\n开始,完成,3\n开始,其他,2'} density="default" />
    <MermaidDiagram code={'sankey-beta\n开始,完成,3\n开始,其他,2'} density="compact" />
  </LocaleProvider>;
  const svgs = () => Array.from(dom.document.querySelectorAll('.maka-mermaid-svg > svg'));
  const ids = () => Array.from(dom.document.querySelectorAll('.maka-mermaid-svg [id]'), node => node.id);
  let root = createRoot(dom.document.querySelector('#root')!);
  try {
    await act(async () => root.render(view()));
    await settleEffects();
    const first = svgs();
    assert.equal(first.length, 4);
    assert.ok(first.every(svg => svg.classList.contains('pele')), 'Mermaid fences must use Pele');
    assert.equal(new Set(ids()).size, ids().length, 'repeated diagrams must not share ids');
    assert.ok(ids().length > 0, 'sankey paint servers must have isolated ids');
    for (const svg of first.slice(0, 2)) {
      assert.match(svg.textContent!, /开始/);
      assert.match(svg.textContent!, /第二行/);
      assert.match(svg.textContent!, /服务/);
    }
    for (const svg of first.slice(2)) {
      const ids = new Set(Array.from(svg.querySelectorAll('[id]'), node => node.id));
      for (const node of svg.querySelectorAll('[fill]')) {
        const id = /url\(#([^)]+)\)/.exec(node.getAttribute('fill')!)?.[1];
        if (id) assert.ok(ids.has(id), 'paint servers must refer to this SVG instance');
      }
    }
    dom.document.documentElement.classList.add('dark');
    await settleEffects();
    assert.deepEqual(svgs(), first, 'theme switches must preserve the mounted SVGs');
    const oldIds = new Set(ids());
    await act(async () => root.unmount());
    const container = dom.document.createElement('div');
    dom.document.body.append(container);
    root = createRoot(container);
    const commits: string[][] = [];
    await act(async () => root.render(<Profiler id="cache" onRender={() => {
      commits.push(Array.from(container.querySelectorAll('[data-maka-mermaid-state]'), node => node.getAttribute('data-maka-mermaid-state')!));
    }}>{view()}</Profiler>));
    await settleEffects();
    assert.ok(commits.length > 0);
    assert.ok(commits.every(states => states.every(state => state === 'rendered')), 'cached remounts must not flash source/loading');
    assert.ok(ids().every(id => !oldIds.has(id)), 'cached instances must receive fresh ids');
  } finally {
    await act(async () => root.unmount());
    dom.restore();
  }
});

test('keeps navigation, scripts, HTML, and images out of diagrams and rejects oversized graphs', async () => {
  const dom = installDom();
  const root = createRoot(dom.document.querySelector('#root')!);
  const edges = 'flowchart LR\n' + Array.from({ length: 501 }, (_, index) => `a --> n${index}`).join('\n');
  try {
    await act(async () => root.render(<LocaleProvider locale="en">
      <MermaidDiagram code={'flowchart LR\nA["<script>alert(1)</script>"] --> B[完成]\nclick A "https://example.com/navigation"'} density="default" />
      <MermaidDiagram code={edges} density="default" />
    </LocaleProvider>));
    await settleEffects();
    const svg = dom.document.querySelector('.maka-mermaid-svg > svg');
    assert.ok(svg, 'the untrusted diagram must still render');
    assert.equal(svg.querySelectorAll('a, script, foreignObject, image').length, 0);
    assert.equal(dom.document.querySelectorAll('[data-maka-mermaid-state="error"]').length, 1, 'edge limit must reject the graph');
  } finally {
    await act(async () => root.unmount());
    dom.restore();
  }
});

test('evicts old templates while retaining recently viewed diagrams', async () => {
  const dom = installDom();
  const root = createRoot(dom.document.querySelector('#root')!);
  const commits: string[] = [];
  const prefix = `lru${Date.now()}`;
  let mount = 0;
  const show = async (index: number) => {
    commits.length = 0;
    await act(async () => root.render(<Profiler id="lru" onRender={() => {
      commits.push(dom.document.querySelector('[data-maka-mermaid-state]')!.getAttribute('data-maka-mermaid-state')!);
    }}><LocaleProvider locale="en"><MermaidDiagram key={++mount} code={`flowchart LR\n${prefix}${index} --> done`} density="default" /></LocaleProvider></Profiler>));
    await settleEffects();
  };
  try {
    for (let index = 0; index < MERMAID_RENDER_CACHE_LIMIT; index++) await show(index);
    await show(0);
    assert.equal(commits[0], 'rendered', 'a cached mount must retain its diagram');
    await show(MERMAID_RENDER_CACHE_LIMIT);
    await show(0);
    assert.equal(commits[0], 'rendered', 'viewing a cached diagram must refresh its recency');
    await show(1);
    assert.equal(commits[0], 'loading', 'the least recently viewed template must be evicted');
    assert.equal(commits.at(-1), 'rendered');
  } finally {
    await act(async () => root.unmount());
    dom.restore();
  }
});

test('re-rendering one diagram at many widths keeps other cached diagrams', async () => {
  const dom = installDom();
  let width = 700;
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => width });
  const root = createRoot(dom.document.querySelector('#root')!);
  const commits: string[] = [];
  const prefix = `resize${Date.now()}`;
  let mount = 0;
  const show = async (name: string) => {
    commits.length = 0;
    await act(async () => root.render(<Profiler id="resize" onRender={() => {
      commits.push(dom.document.querySelector('[data-maka-mermaid-state]')!.getAttribute('data-maka-mermaid-state')!);
    }}><LocaleProvider locale="en"><MermaidDiagram key={++mount} code={`flowchart LR\n${prefix}${name} --> done`} density="default" /></LocaleProvider></Profiler>));
    await settleEffects();
  };
  try {
    await show('a');
    for (let step = 0; step <= MERMAID_RENDER_CACHE_LIMIT; step++) {
      width = 400 + step;
      await show('b');
      assert.equal(commits.at(-1), 'rendered');
    }
    await show('a');
    assert.equal(commits[0], 'rendered', 'layout widths of one diagram must not evict other diagrams');
  } finally {
    await act(async () => root.unmount());
    dom.restore();
  }
});

function installResizableContainer(initialWidth: number) {
  let width = initialWidth;
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => width });
  const resizeCallbacks = new Set<() => void>();
  globalThis.ResizeObserver = class {
    #callback: () => void;
    constructor(callback: () => void) { this.#callback = callback; }
    observe() { resizeCallbacks.add(this.#callback); }
    unobserve() {}
    disconnect() { resizeCallbacks.delete(this.#callback); }
  } as unknown as typeof ResizeObserver;
  const notify = async (next: number) => {
    width = next;
    await act(async () => { for (const callback of resizeCallbacks) callback(); });
    await settleEffects();
  };
  const settle = async () => {
    await act(() => new Promise((resolve) => setTimeout(resolve, MERMAID_RESIZE_SETTLE_MS + 20)));
    await settleEffects();
  };
  return { notify, settle, resize: async (next: number) => { await notify(next); await settle(); } };
}

const relayoutCode = `flowchart LR\naccTitle: Relayout\n${Array.from({ length: 4 }, (_, index) => `n${index}[relayout ${index}] --> n${index + 1}[relayout ${index + 1}]`).join('\n')}`;

test('re-lays out a diagram only when the container is narrower than it', async () => {
  const dom = installDom();
  const width = 1200;
  const { resize } = installResizableContainer(width);
  const root = createRoot(dom.document.querySelector('#root')!);
  const svg = () => dom.document.querySelector('.maka-mermaid-svg > svg');
  const code = relayoutCode;
  try {
    await act(async () => root.render(<LocaleProvider locale="en"><MermaidDiagram code={code} density="default" /></LocaleProvider>));
    await settleEffects();
    const natural = svg();
    const naturalWidth = Number(natural?.getAttribute('width'));
    assert.ok(naturalWidth > 0 && naturalWidth < width - 64, 'the diagram must fit the initial container');
    await resize(naturalWidth + 64 + 100);
    await resize(naturalWidth + 64 + 50);
    assert.ok(svg() === natural, 'resizing a container that still fits the diagram must not re-render it');
    await resize(320);
    assert.ok(svg() !== natural, 'a container narrower than the diagram must re-lay it out');
    assert.ok(Number(svg()?.getAttribute('width')) < naturalWidth);
    await act(async () => root.render(<LocaleProvider locale="en"><MermaidDiagram code={'flowchart LR\nnext --> source'} density="default" /></LocaleProvider>));
    await settleEffects();
    assert.match(svg()?.textContent ?? '', /next/, 'a new source must replace the diagram');
  } finally {
    await act(async () => root.unmount());
    dom.restore();
  }
});

test('re-lays out once after a resize burst settles and keeps the diagram meanwhile', async () => {
  const dom = installDom();
  const { notify, settle } = installResizableContainer(1200);
  const root = createRoot(dom.document.querySelector('#root')!);
  const svg = () => dom.document.querySelector('.maka-mermaid-svg > svg');
  try {
    await act(async () => root.render(<LocaleProvider locale="en"><MermaidDiagram code={`${relayoutCode}\naccDescr: burst`} density="default" /></LocaleProvider>));
    await settleEffects();
    const natural = svg();
    assert.ok(natural);
    const seen = new Set<Element | null>([natural]);
    for (let next = 700; next >= 300; next -= 25) {
      await notify(next);
      seen.add(svg());
    }
    assert.deepEqual([...seen], [natural], 'a resize burst must keep the mounted diagram instead of laying it out per event');
    await settle();
    seen.add(svg());
    assert.equal(seen.size, 2, 'a settled resize must lay the diagram out exactly once');
    assert.ok(Number(svg()?.getAttribute('width')) < Number(natural.getAttribute('width')));
  } finally {
    await act(async () => root.unmount());
    dom.restore();
  }
});
