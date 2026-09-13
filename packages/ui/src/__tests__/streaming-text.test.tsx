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
import { afterEach, test } from 'node:test';
import { useStreamingText } from '@astryxdesign/core';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { LocaleProvider } from '../locale-context.js';
import { MarkdownBody } from '../markdown-body.js';

const originalGlobals = {
  document: globalThis.document,
  matchMedia: globalThis.matchMedia,
  requestAnimationFrame: globalThis.requestAnimationFrame,
  cancelAnimationFrame: globalThis.cancelAnimationFrame,
  window: globalThis.window,
};
const originalActEnvironment = (globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
}).IS_REACT_ACT_ENVIRONMENT;

afterEach(() => {
  Object.assign(globalThis, {
    ...originalGlobals,
    IS_REACT_ACT_ENVIRONMENT: originalActEnvironment,
  });
});

function streamingRoot(
  requestAnimationFrame: (callback: FrameRequestCallback) => number = () => 1,
) {
  const { document, window } = parseHTML('<div id="root"></div>');
  Object.assign(window, {
    getComputedStyle: () => ({ direction: 'ltr', writingMode: 'horizontal-tb' }),
  });
  Object.assign(globalThis, {
    document,
    window,
    matchMedia: () => ({
      matches: false,
      addEventListener() {},
      removeEventListener() {},
    }),
    requestAnimationFrame,
    cancelAnimationFrame() {},
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const container = document.querySelector('#root');
  assert.ok(container);
  return { container, root: createRoot(container) };
}

test('settles an authoritative baseline delivered after mount', async () => {
  const { container, root } = streamingRoot();

  function Harness(props: { target: string; baseline: string }) {
    return useStreamingText(props.target, true, {
      settledText: props.baseline,
    });
  }

  await act(() => root.render(<Harness target="old" baseline="old" />));
  assert.equal(container.textContent, 'old');

  await act(() => root.render(
    <Harness target="old background" baseline="old" />,
  ));
  assert.equal(container.textContent, 'old');

  await act(() => root.render(
    <Harness target="old background" baseline="old background" />,
  ));
  assert.equal(container.textContent, 'old background');

  await act(() => root.unmount());
});

test('never reveals half of a Unicode code point', async () => {
  let frame: FrameRequestCallback | undefined;
  const { container, root } = streamingRoot((callback) => {
    frame = callback;
    return 1;
  });

  function Harness() {
    return useStreamingText('a123456789😀tail', true, {
      settledText: 'a',
    });
  }

  await act(() => root.render(<Harness />));
  assert.equal(container.textContent, 'a');
  assert.ok(frame);
  await act(() => frame?.(100));
  assert.equal(container.textContent, 'a123456789😀');

  await act(() => root.unmount());
});

test('keeps settled math stable while the live Markdown tail grows and flushes', async () => {
  const frames: FrameRequestCallback[] = [];
  const { container, root } = streamingRoot((callback) => {
    frames.push(callback);
    return frames.length;
  });
  const settled = [
    'Before',
    '',
    '\\( \\texttt{https://example.com} + \\text{person@example.com} \\)',
    '',
    '',
  ].join('\n');

  function render(text: string, streaming: boolean) {
    return root.render(
      <LocaleProvider locale="en">
        <MarkdownBody
          text={text}
          settledText={streaming ? settled : undefined}
          streaming={streaming}
        />
      </LocaleProvider>,
    );
  }

  await act(() => render(`${settled}growing`, true));
  const math = container.querySelector('.maka-math');
  assert.ok(math);
  assert.ok(math.querySelector('.katex'));
  assert.equal(container.querySelector('a'), null);

  const firstFrame = frames.shift();
  assert.ok(firstFrame);
  await act(() => firstFrame(100));
  assert.equal(container.querySelector('.maka-math'), math);

  await act(() => render(`${settled}growing live tail`, true));
  const secondFrame = frames.shift();
  assert.ok(secondFrame);
  await act(() => secondFrame(200));
  assert.equal(container.querySelector('.maka-math'), math);
  assert.equal(container.querySelector('a'), null);

  await act(() => render(`${settled}final tail`, false));
  assert.ok(container.querySelector('.maka-math .katex'));
  assert.equal(container.querySelector('a'), null);
  assert.match(container.textContent ?? '', /final tail/);

  await act(() => root.unmount());
});

test('never exposes math transport syntax as a formula crosses the display cursor', async () => {
  const frames: FrameRequestCallback[] = [];
  const { container, root } = streamingRoot((callback) => {
    frames.push(callback);
    return frames.length;
  });
  const target = 'Before \\(x + 1\\) after';

  await act(() => root.render(
    <LocaleProvider locale="en">
      <MarkdownBody text={target} settledText="Before " streaming />
    </LocaleProvider>,
  ));

  for (let tick = 1; tick <= 8 && container.querySelector('.maka-math') === null; tick++) {
    const frame = frames.shift();
    assert.ok(frame);
    await act(() => frame(tick * 100));
    assert.doesNotMatch(container.textContent ?? '', /MAKA_MATH|\uE000|\uE001/);
  }

  assert.ok(container.querySelector('.maka-math .katex'));
  assert.match(container.textContent ?? '', /Before/);
  await act(() => root.unmount());
});

test('keeps a restored prefix inside math visible and handles a formula rewrite', async () => {
  const frames: FrameRequestCallback[] = [];
  const { container, root } = streamingRoot((callback) => {
    frames.push(callback);
    return frames.length;
  });
  const first = 'Before \\(x + 1\\) after';
  const second = 'Before \\(x + 2\\) after';

  await act(() => root.render(
    <LocaleProvider locale="en">
      <MarkdownBody text={first} settledText={'Before \\(x'} streaming />
    </LocaleProvider>,
  ));
  assert.match(container.textContent ?? '', /Before \(x/);
  assert.doesNotMatch(container.textContent ?? '', /MAKA_MATH|\uE000|\uE001/);

  await act(() => root.render(
    <LocaleProvider locale="en">
      <MarkdownBody text={second} settledText={first} streaming />
    </LocaleProvider>,
  ));
  assert.doesNotMatch(container.textContent ?? '', /MAKA_MATH|\uE000|\uE001/);

  for (let tick = 1; tick <= 8 && container.querySelector('.maka-math') === null; tick++) {
    const frame = frames.shift();
    assert.ok(frame);
    await act(() => frame(tick * 100));
    assert.doesNotMatch(container.textContent ?? '', /MAKA_MATH|\uE000|\uE001/);
  }
  assert.ok(container.querySelector('.maka-math .katex'));
  assert.match(container.textContent ?? '', /2/);

  await act(() => root.unmount());
});

test('keeps split fenced-code openers literal through final flush', async () => {
  for (const { prefix, target } of [
    { prefix: '~~', target: '~~~ts\n\\(not math\\)\n~~~' },
    { prefix: '``', target: '```ts\n\\(not math\\)\n```' },
  ]) {
    const frames: FrameRequestCallback[] = [];
    const { container, root } = streamingRoot((callback) => {
      frames.push(callback);
      return frames.length;
    });
    const render = (text: string, streaming: boolean) => root.render(
      <LocaleProvider locale="en">
        <MarkdownBody
          text={text}
          settledText={streaming ? prefix : undefined}
          streaming={streaming}
        />
      </LocaleProvider>,
    );

    await act(() => render(prefix, true));
    await act(() => render(target, true));
    for (let tick = 1; tick <= 30 && frames.length > 0; tick++) {
      const frame = frames.shift();
      assert.ok(frame);
      await act(() => frame(tick * 100));
    }
    await act(() => render(target, false));

    assert.equal(container.querySelector('code')?.textContent, '\\(not math\\)');
    assert.equal(container.querySelector('.maka-math'), null);
    assert.doesNotMatch(container.textContent ?? '', /MAKA_MATH|\uE000|\uE001/);
    await act(() => root.unmount());
  }
});
