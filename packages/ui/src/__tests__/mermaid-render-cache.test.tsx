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
import { parseHTML } from 'linkedom';
import { LocaleProvider } from '../locale-context.js';
import {
  MERMAID_RENDER_CACHE_LIMIT,
  MermaidDiagram,
} from '../mermaid-diagram.js';

const GLOBAL_KEYS = [
  'CSS',
  'DOMParser',
  'Element',
  'HTMLElement',
  'IS_REACT_ACT_ENVIRONMENT',
  'MutationObserver',
  'Node',
  'ResizeObserver',
  'XMLSerializer',
  'cancelAnimationFrame',
  'document',
  'getComputedStyle',
  'navigator',
  'requestAnimationFrame',
  'window',
] as const;

function installDom() {
  const originals = new Map<PropertyKey, PropertyDescriptor | undefined>(
    GLOBAL_KEYS.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  );
  const { document, window } = parseHTML('<html><body><div id="root"></div></body></html>');
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: new URL('http://localhost/'),
  });

  class InertResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  class TestXmlSerializer {
    serializeToString(node: Node): string {
      return String(node);
    }
  }
  const globals = {
    CSS: { escape: String, supports: () => false },
    DOMParser: window.DOMParser,
    Element: window.Element,
    HTMLElement: window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
    MutationObserver: window.MutationObserver,
    Node: window.Node,
    ResizeObserver: InertResizeObserver,
    XMLSerializer: TestXmlSerializer,
    cancelAnimationFrame: () => {},
    document,
    getComputedStyle: () => ({
      paddingBottom: '0',
      paddingLeft: '0',
      paddingRight: '0',
      paddingTop: '0',
    }),
    navigator: window.navigator ?? { userAgent: 'node' },
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      queueMicrotask(() => callback(0));
      return 1;
    },
    window,
  };
  for (const [key, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, key, {
      configurable: true,
      value,
      writable: true,
    });
  }
  Object.assign(window, {
    CSS: globals.CSS,
    cancelAnimationFrame: globals.cancelAnimationFrame,
    getComputedStyle: globals.getComputedStyle,
    innerHeight: 800,
    requestAnimationFrame: globals.requestAnimationFrame,
  });

  return {
    document,
    restore() {
      for (const key of GLOBAL_KEYS) {
        const descriptor = originals.get(key);
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}

async function settleEffects(): Promise<void> {
  for (let index = 0; index < 8; index += 1) {
    await act(async () => Promise.resolve());
  }
}

function diagram(code: string) {
  return (
    <LocaleProvider locale="en">
      <MermaidDiagram code={code} density="default" />
    </LocaleProvider>
  );
}

test('reuses a rendered Mermaid result across remounts and isolates themes', async () => {
  const dom = installDom();
  const mermaid = (await import('mermaid')).default;
  const originalInitialize = mermaid.initialize;
  const originalRender = mermaid.render;
  let renderCalls = 0;
  const themes: string[] = [];
  mermaid.initialize = (config) => {
    themes.push(String(config.theme));
  };
  mermaid.render = async (id, code) => {
    renderCalls += 1;
    return {
      diagramType: 'flowchart-v2',
      svg: `<svg id="${id}" viewBox="0 0 100 50"><text>${code}</text></svg>`,
    };
  };

  const code = 'flowchart LR\ncache_a --> cache_b';
  const view = () => diagram(code);
  let root = createRoot(dom.document.querySelector('#root')!);

  try {
    await act(async () => root.render(view()));
    await settleEffects();
    assert.equal(renderCalls, 1);

    await act(async () => root.unmount());
    const remount = dom.document.createElement('div');
    dom.document.body.appendChild(remount);
    root = createRoot(remount);
    await act(async () => root.render(view()));
    await settleEffects();
    assert.equal(renderCalls, 1, 'same source and theme should hit the render cache');

    dom.document.documentElement.classList.add('dark');
    await settleEffects();
    assert.equal(renderCalls, 2, 'dark theme must use a distinct render result');

    dom.document.documentElement.classList.remove('dark');
    await settleEffects();
    assert.equal(renderCalls, 2, 'switching back should reuse the cached default-theme result');
    assert.deepEqual(themes, ['default', 'dark']);
  } finally {
    await act(async () => root.unmount());
    mermaid.initialize = originalInitialize;
    mermaid.render = originalRender;
    dom.restore();
  }
});

test('coalesces concurrent Mermaid renders and gives cached instances unique SVG ids', async () => {
  const dom = installDom();
  const mermaid = (await import('mermaid')).default;
  const originalInitialize = mermaid.initialize;
  const originalRender = mermaid.render;
  let renderCalls = 0;
  let releaseRender: (() => void) | undefined;
  mermaid.initialize = () => {};
  mermaid.render = (id) => {
    renderCalls += 1;
    return new Promise((resolve) => {
      releaseRender = () => resolve({
        diagramType: 'flowchart-v2',
        svg: [
          `<svg id="${id}" viewBox="0 0 100 50" aria-labelledby="actor1">`,
          `<style>#${id}-node{fill:red}#root-1{filter:url(#drop-shadow)}</style>`,
          '<title id="actor1">Title</title>',
          `<defs><marker id="${id}-arrow"><path /></marker><filter id="drop-shadow" /></defs>`,
          `<g id="root-1" filter="url(#drop-shadow)"><path id="${id}-node" marker-end="url(#${id}-arrow)" /></g>`,
          '</svg>',
        ].join(''),
      });
    });
  };

  const code = 'flowchart LR\nconcurrent_a --> concurrent_b';
  const root = createRoot(dom.document.querySelector('#root')!);

  try {
    await act(async () => root.render(
      <LocaleProvider locale="en">
        <MermaidDiagram code={code} density="default" />
        <MermaidDiagram code={code} density="compact" />
      </LocaleProvider>,
    ));
    await settleEffects();
    assert.equal(renderCalls, 1, 'same-key mounts should share the in-flight render');

    await act(async () => releaseRender?.());
    await settleEffects();
    const diagrams = Array.from(dom.document.querySelectorAll('.maka-mermaid-svg > svg'));
    assert.equal(diagrams.length, 2);
    const firstIds = new Set(Array.from(diagrams[0]!.querySelectorAll('[id]'), (node) => node.id));
    const secondIds = new Set(Array.from(diagrams[1]!.querySelectorAll('[id]'), (node) => node.id));
    assert.equal([...firstIds].some((id) => secondIds.has(id)), false, 'instances must not share DOM ids');
    for (const svg of diagrams) {
      const marker = svg.querySelector('marker')!;
      const filter = svg.querySelector('filter')!;
      const group = svg.querySelector('g')!;
      const path = svg.querySelector('path[id]')!;
      const title = svg.querySelector('title')!;
      assert.equal(path.getAttribute('marker-end'), `url(#${marker.id})`);
      assert.equal(group.getAttribute('filter'), `url(#${filter.id})`);
      assert.equal(svg.getAttribute('aria-labelledby'), title.id);
      const style = svg.querySelector('style')!.textContent ?? '';
      assert.match(style, new RegExp(`#${path.id}`));
      assert.match(style, new RegExp(`#${group.id}`));
      assert.match(style, new RegExp(`url\\(#${filter.id}\\)`));
    }
  } finally {
    await act(async () => root.unmount());
    mermaid.initialize = originalInitialize;
    mermaid.render = originalRender;
    dom.restore();
  }
});

test('does not cancel a shared Mermaid render while another consumer remains mounted', async () => {
  const dom = installDom();
  const mermaid = (await import('mermaid')).default;
  const originalInitialize = mermaid.initialize;
  const originalRender = mermaid.render;
  let renderCalls = 0;
  let releaseRender: (() => void) | undefined;
  mermaid.initialize = () => {};
  mermaid.render = (id, code) => {
    renderCalls += 1;
    return new Promise((resolve) => {
      releaseRender = () => resolve({
        diagramType: 'flowchart-v2',
        svg: `<svg id="${id}" viewBox="0 0 100 50"><text>${code}</text></svg>`,
      });
    });
  };

  const code = 'flowchart LR\nremaining_a --> remaining_b';
  const root = createRoot(dom.document.querySelector('#root')!);
  const view = (showFirst: boolean) => (
    <LocaleProvider locale="en">
      {showFirst ? <MermaidDiagram key="first" code={code} density="default" /> : null}
      <MermaidDiagram key="second" code={code} density="compact" />
    </LocaleProvider>
  );

  try {
    await act(async () => root.render(view(true)));
    await settleEffects();
    assert.equal(renderCalls, 1);

    await act(async () => root.render(view(false)));
    await act(async () => releaseRender?.());
    await settleEffects();
    assert.equal(
      dom.document.querySelectorAll('[data-maka-mermaid-state="rendered"]').length,
      1,
    );
  } finally {
    await act(async () => root.unmount());
    mermaid.initialize = originalInitialize;
    mermaid.render = originalRender;
    dom.restore();
  }
});

test('bounds the Mermaid cache and evicts its least recently used result', async () => {
  const dom = installDom();
  const mermaid = (await import('mermaid')).default;
  const originalInitialize = mermaid.initialize;
  const originalRender = mermaid.render;
  let renderCalls = 0;
  mermaid.initialize = () => {};
  mermaid.render = async (id, code) => {
    renderCalls += 1;
    return {
      diagramType: 'flowchart-v2',
      svg: `<svg id="${id}" viewBox="0 0 100 50"><text>${code}</text></svg>`,
    };
  };

  const root = createRoot(dom.document.querySelector('#root')!);
  const prefix = `lru-${Date.now()}-`;
  const renderCode = async (code: string) => {
    await act(async () => root.render(diagram(code)));
    await settleEffects();
  };

  try {
    for (let index = 0; index < MERMAID_RENDER_CACHE_LIMIT; index += 1) {
      await renderCode(`${prefix}${index}`);
    }
    assert.equal(renderCalls, MERMAID_RENDER_CACHE_LIMIT);

    await renderCode(`${prefix}0`);
    assert.equal(renderCalls, MERMAID_RENDER_CACHE_LIMIT, 'a cache hit should refresh recency');

    await renderCode(`${prefix}${MERMAID_RENDER_CACHE_LIMIT}`);
    assert.equal(renderCalls, MERMAID_RENDER_CACHE_LIMIT + 1);

    await renderCode(`${prefix}0`);
    assert.equal(renderCalls, MERMAID_RENDER_CACHE_LIMIT + 1, 'the refreshed entry should survive');

    await renderCode(`${prefix}1`);
    assert.equal(
      renderCalls,
      MERMAID_RENDER_CACHE_LIMIT + 2,
      'the oldest entry should be rendered again after LRU eviction',
    );
  } finally {
    await act(async () => root.unmount());
    mermaid.initialize = originalInitialize;
    mermaid.render = originalRender;
    dom.restore();
  }
});
