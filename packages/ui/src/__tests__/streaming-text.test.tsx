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

test('settles an authoritative baseline delivered after mount', async () => {
  const { document, window } = parseHTML('<div id="root"></div>');
  Object.assign(globalThis, {
    document,
    window,
    matchMedia: () => ({
      matches: false,
      addEventListener() {},
      removeEventListener() {},
    }),
    requestAnimationFrame: () => 1,
    cancelAnimationFrame() {},
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const container = document.querySelector('#root');
  assert.ok(container);
  const root = createRoot(container);

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
