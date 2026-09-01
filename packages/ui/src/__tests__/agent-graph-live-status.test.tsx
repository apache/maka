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
import { afterEach, mock, test } from 'node:test';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { AgentGraphLiveStatus } from '../agent-graph-live-status.js';

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
const mountedRoots: ReturnType<typeof createRoot>[] = [];

afterEach(async () => {
  mock.timers.reset();
  for (const root of mountedRoots.splice(0)) await act(() => root.unmount());
  Object.assign(globalThis, {
    ...originalGlobals,
    IS_REACT_ACT_ENVIRONMENT: originalActEnvironment,
  });
});

function domRoot() {
  const { document, window } = parseHTML('<div id="root"></div>');
  Object.assign(globalThis, {
    document,
    window,
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    requestAnimationFrame: () => 1,
    cancelAnimationFrame() {},
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const container = document.querySelector('#root');
  assert.ok(container);
  const root = createRoot(container);
  mountedRoots.push(root);
  return { container, root };
}

type LiveStatusInput = {
  readonly live: boolean;
  readonly resetKey: string;
  readonly label: string;
};

async function renderLiveStatus(input: LiveStatusInput, children = 'running · 3/7 settled') {
  const { container, root } = domRoot();
  await act(async () => {
    root.render(
      <AgentGraphLiveStatus live={input.live} resetKey={input.resetKey} label={input.label}>
        {children}
      </AgentGraphLiveStatus>,
    );
  });
  return { container, root };
}

function rerenderLiveStatus(
  root: ReturnType<typeof createRoot>,
  input: LiveStatusInput,
  children = 'running · 3/7 settled',
) {
  return act(async () => {
    root.render(
      <AgentGraphLiveStatus live={input.live} resetKey={input.resetKey} label={input.label}>
        {children}
      </AgentGraphLiveStatus>,
    );
  });
}

test('idle graphs render only their own status content', async () => {
  mock.timers.enable({ apis: ['Date', 'setInterval'] });
  const { container } = await renderLiveStatus({ live: false, resetKey: 'g1', label: 'running' });
  assert.equal(container.querySelector('.maka-agent-graph-heartbeat'), null);
  assert.equal(container.querySelector('.maka-agent-graph-elapsed'), null);
  assert.match(container.textContent ?? '', /running · 3\/7 settled/u);
});

test('live graphs gain a labelled heartbeat and a ticking stopwatch', async () => {
  mock.timers.enable({ apis: ['Date', 'setInterval'] });
  const { container, root } = await renderLiveStatus({ live: true, resetKey: 'g1', label: 'running' });
  const heartbeat = container.querySelector('.maka-agent-graph-heartbeat');
  assert.ok(heartbeat);
  assert.equal(heartbeat.getAttribute('aria-label'), 'running');
  assert.match(container.querySelector('.maka-agent-graph-elapsed')?.textContent ?? '', /00:00/u);

  await act(async () => {
    mock.timers.tick(2500);
  });
  assert.match(container.querySelector('.maka-agent-graph-elapsed')?.textContent ?? '', /00:02/u);
  await rerenderLiveStatus(root, { live: true, resetKey: 'g1', label: 'running' });
  assert.match(container.querySelector('.maka-agent-graph-elapsed')?.textContent ?? '', /00:02/u);
});

test('the stopwatch resets when the selection moves to another graph', async () => {
  mock.timers.enable({ apis: ['Date', 'setInterval'] });
  const { container, root } = await renderLiveStatus({ live: true, resetKey: 'g1', label: 'running' });
  await act(async () => {
    mock.timers.tick(6500);
  });
  assert.match(container.querySelector('.maka-agent-graph-elapsed')?.textContent ?? '', /00:06/u);

  await rerenderLiveStatus(root, { live: true, resetKey: 'g2', label: 'waiting' });
  assert.match(container.querySelector('.maka-agent-graph-elapsed')?.textContent ?? '', /00:00/u);
  const heartbeat = container.querySelector('.maka-agent-graph-heartbeat');
  assert.equal(heartbeat?.getAttribute('aria-label'), 'waiting');
});

test('going idle retires the heartbeat and the clock but keeps the status content', async () => {
  mock.timers.enable({ apis: ['Date', 'setInterval'] });
  const { container, root } = await renderLiveStatus({ live: true, resetKey: 'g1', label: 'running' });
  await act(async () => {
    mock.timers.tick(1000);
  });
  await rerenderLiveStatus(root, { live: false, resetKey: 'g1', label: 'completed' });
  assert.equal(container.querySelector('.maka-agent-graph-heartbeat'), null);
  assert.equal(container.querySelector('.maka-agent-graph-elapsed'), null);
  assert.match(container.textContent ?? '', /running · 3\/7 settled/u);
});
