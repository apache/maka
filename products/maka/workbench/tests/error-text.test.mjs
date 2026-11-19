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
import { registerHooks } from 'node:module';
import test from 'node:test';

const app = new URL('../app/', import.meta.url);
const stubs = {
  './locale': `
    export const tr = (key, values = {}) =>
      key.replace(/\\{(\\w+)\\}/g, (placeholder, name) => values[name] ?? placeholder);
  `,
  nsh: 'export const cleanup = () => {}; export const signal = () => () => {};',
};
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL?.startsWith(app.href) && specifier in stubs)
      return {
        url: `data:text/javascript,${encodeURIComponent(stubs[specifier])}`,
        shortCircuit: true,
      };
    if (context.parentURL?.startsWith(app.href) && specifier === './text-value')
      return { url: new URL('text-value.ts', app).href, shortCircuit: true };
    return next(specifier, context);
  },
});
const { errorText, renderText, UiError } = await import(new URL('text.ts', app));
hooks.deregister();

test('an unrecognized error keeps the action and adds the reason', () => {
  const reason = new Error('model HTTP request failed (status 400)');
  assert.equal(
    renderText(errorText(reason, 'Could not continue the response.')),
    'Could not continue the response. model HTTP request failed (status 400)',
  );
});

test('known errors keep their own text, without the raw reason', () => {
  assert.equal(
    renderText(errorText(new Error('agent_closed'), 'Could not send the message.')),
    'Connection interrupted. Your draft is kept.',
  );
  assert.equal(
    renderText(errorText(new UiError('Could not send the message.'), 'Could not save the draft.')),
    'Could not send the message.',
  );
  assert.equal(renderText(errorText(new Error(''), 'Could not send the message.')), '');
});
