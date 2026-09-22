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
import { parseHTML } from 'linkedom';
import type { FormInteractionMessage } from '@maka/core/session';
import { FormInteractionHistory } from '../form-interaction-history.js';
import { LocaleProvider } from '../locale-context.js';

const message: FormInteractionMessage = {
  type: 'form_interaction', id: 'choice', turnId: 'turn', ts: 1,
  request: { kind: 'form', toolUseId: 'tool', message: 'Which login work should continue?', requester: { name: 'WorkHub' },
    fields: [{ kind: 'single_select', name: 'target', label: 'Work', required: true,
      options: [{ value: 'ui', label: 'Login UI', description: 'Page work' }, { value: 'api', label: 'Login API', description: 'Server work' }] }] },
  outcome: { kind: 'form_answer', action: 'accept', values: { target: 'api' }, committedAt: 2 },
};

test('choice history uses a collapsed native disclosure retaining the complete question and every option', () => {
  const { document } = parseHTML(renderToStaticMarkup(<LocaleProvider locale="en"><FormInteractionHistory message={message} /></LocaleProvider>));
  const details = document.querySelector('details')!;
  assert.ok(details);
  assert.equal(details.hasAttribute('open'), false);
  assert.equal(details.querySelector('summary')?.textContent, 'You selected: Login API');
  assert.match(details.textContent!, /Which login work should continue/);
  assert.equal(details.querySelectorAll('li').length, 2);
  assert.match(details.querySelector('li[data-selected="true"]')!.textContent!, /Login API/);
  assert.match(details.textContent!, /Page work/);
  assert.match(details.textContent!, /Server work/);
});

test('cancelled and closed forms never imply that an option was selected', () => {
  for (const outcome of [{ kind: 'form_answer', action: 'cancel', committedAt: 2 }, { kind: 'closure', reason: 'turn_terminal', committedAt: 2 }] as const) {
    const html = renderToStaticMarkup(<LocaleProvider locale="en"><FormInteractionHistory message={{ ...message, outcome }} /></LocaleProvider>);
    assert.doesNotMatch(html, /data-selected="true"/);
    assert.match(html, /Login UI/);
    assert.match(html, /Login API/);
  }
});


test('model question choices preserve the full question, all options and free-text answers', () => {
  const request = { kind: 'question', toolUseId: 'tool', questions: [{ question: 'Which work should stop?', options: [{ label: 'Both', description: 'Stop both tasks' }, { label: 'Only UI' }] }] } as const;
  for (const answer of ['Only UI', 'Neither yet']) {
    const { document } = parseHTML(renderToStaticMarkup(<LocaleProvider locale="en"><FormInteractionHistory message={{ ...message, request, outcome: { kind: 'question_answer', answers: [answer], committedAt: 2 } }} /></LocaleProvider>));
    assert.equal(document.querySelector('details')?.hasAttribute('open'), false);
    assert.match(document.querySelector('details')!.textContent!, /Which work should stop/);
    assert.equal(document.querySelectorAll('li').length, 2);
    assert.equal(document.querySelector('summary')?.textContent, `You selected: ${answer}`);
    assert.equal(document.querySelectorAll('li[data-selected="true"]').length, answer === 'Only UI' ? 1 : 0);
  }
});
