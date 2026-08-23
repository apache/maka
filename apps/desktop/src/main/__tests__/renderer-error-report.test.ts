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
import { formatRendererErrorReport, RENDERER_ERROR_REPORT_MAX_BYTES } from '../../renderer/error-boundary.js';

const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
  if (originalNavigator) {
    Object.defineProperty(globalThis, 'navigator', originalNavigator);
  } else {
    delete (globalThis as { navigator?: unknown }).navigator;
  }
});

test('bounds and redacts the browser-only renderer error report', () => {
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { userAgent: `browser/${'u'.repeat(8 * 1024)}` },
  });
  (globalThis as { window?: unknown }).window = {
    location: {
      href: `data:text/plain,?token=sk-locationsecret123&payload=${'🚀'.repeat(16 * 1024)}`,
    },
  };
  const error = new Error(`api_key=sk-messagesecret123 ${'故障'.repeat(16 * 1024)}`);
  error.stack = `Error: token=sk-stacksecret123\n${'stack frame\n'.repeat(8 * 1024)}`;

  const report = formatRendererErrorReport(error, {
    componentStack: `\n${'component\n'.repeat(8 * 1024)}`,
  });

  assert.ok(Buffer.byteLength(report, 'utf8') <= RENDERER_ERROR_REPORT_MAX_BYTES);
  assert.match(report, /<renderer diagnostic (?:field|report) truncated>/);
  assert.match(report, /(?:<redacted>|\[redacted\])/);
  assert.doesNotMatch(report, /sk-(?:location|message|stack)secret123/);
  assert.match(report, /^Maka renderer error report/);
});
