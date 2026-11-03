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
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { LocaleProvider } from '../locale-context.js';
import { MessageSummary } from '../message-summary.js';

test('authored preview is collapsed while the complete body is retained', () => {
  const html = renderToStaticMarkup(<LocaleProvider locale="en"><MessageSummary summary="School starts earlier"><p>Full time and evidence.</p></MessageSummary></LocaleProvider>);
  assert.match(html, /School starts earlier/);
  assert.match(html, /aria-expanded="false"/);
  assert.match(html, /aria-controls="[^"]+"/);
  assert.match(html, /Show details/);
  assert.match(html, /class="maka-message-summary-body" hidden=""/);
  assert.match(html, /Full time and evidence/);
  assert.doesNotMatch(html, /<details[^>]* open/);
});

test('short and legacy messages without a preview render directly', () => {
  const html = renderToStaticMarkup(<LocaleProvider locale="en"><MessageSummary><p>Got it.</p></MessageSummary></LocaleProvider>);
  assert.equal(html, '<p>Got it.</p>');
});
