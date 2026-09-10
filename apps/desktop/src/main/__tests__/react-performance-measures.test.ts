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
import { PerformanceObserver as NodePerformanceObserver } from 'node:perf_hooks';
import { setImmediate } from 'node:timers/promises';
import test from 'node:test';
import { observeReactPerformanceMeasures } from '../../renderer/platform/desktop/react-performance-measures.js';

test('retires React measures, preserves other diagnostics, and releases its observer', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'PerformanceObserver');
  Object.defineProperty(globalThis, 'PerformanceObserver', { configurable: true, value: NodePerformanceObserver });
  const received: string[] = [];
  const consumer = new NodePerformanceObserver((list) => {
    received.push(...list.getEntries().map((entry) => entry.name));
  });
  consumer.observe({ type: 'measure' });
  let stop = () => {};
  const component = { start: 0, detail: { devtools: { track: 'Components ⚛' } } };
  try {
    performance.measure('react-before-install', component);
    performance.measure('application', { start: 0, detail: { purpose: 'latency' } });
    performance.measure('other-devtools', { start: 0, detail: { devtools: { track: 'Application' } } });
    stop = observeReactPerformanceMeasures();
    for (let i = 0; i < 1000; i++) performance.measure('react-render', component);
    performance.measure('react-scheduler', { start: 0, detail: { devtools: { trackGroup: 'Scheduler ⚛' } } });
    await setImmediate();
    await setImmediate();
    assert.deepEqual(performance.getEntriesByType('measure').map((entry) => entry.name).sort(), ['application', 'other-devtools']);
    assert.equal(received.filter((name) => name === 'react-render').length, 1000);
    assert.ok(received.includes('react-scheduler'));

    stop();
    performance.measure('react-after-dispose', component);
    await setImmediate();
    assert.equal(performance.getEntriesByName('react-after-dispose').length, 1);
    // Reinstallation after HMR also consumes the records delivered while detached.
    stop = observeReactPerformanceMeasures();
    await setImmediate();
    await setImmediate();
    assert.equal(performance.getEntriesByName('react-after-dispose').length, 0);
  } finally {
    stop();
    consumer.disconnect();
    performance.clearMeasures();
    if (descriptor) Object.defineProperty(globalThis, 'PerformanceObserver', descriptor);
    else Reflect.deleteProperty(globalThis, 'PerformanceObserver');
  }
});
