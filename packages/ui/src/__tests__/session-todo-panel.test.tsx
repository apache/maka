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
import { renderToStaticMarkup } from 'react-dom/server';
import { LocaleProvider } from '../locale-context.js';
import { SessionTodoPanel, sessionTodoActiveCount } from '../session-todo-panel.js';

test('renders the Host snapshot as one flat ordered list', () => {
  const items = [
    { content: 'First pending item', status: 'pending' as const },
    { content: 'Second completed item', status: 'completed' as const },
    { content: 'Third active item', status: 'in_progress' as const },
  ];
  assert.equal(sessionTodoActiveCount(items), 2);

  const markup = renderToStaticMarkup(
    <LocaleProvider locale="en">
      <SessionTodoPanel items={items} />
    </LocaleProvider>,
  );
  assert.ok(markup.indexOf('First pending item') < markup.indexOf('Second completed item'));
  assert.ok(markup.indexOf('Second completed item') < markup.indexOf('Third active item'));
  assert.equal(markup.includes('Task Create'), false);
  assert.equal(markup.includes('T1'), false);
});
