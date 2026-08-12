import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { useStreamingText } from '@astryxdesign/core';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';

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
