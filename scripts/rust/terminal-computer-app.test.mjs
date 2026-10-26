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
import {
  computerAppOptions,
  computerAppRiskMessage,
} from '../../products/maka/terminal-shell/app/interaction-computer-app.ts';

test('terminal application consent offers only the original allowed lifetimes', () => {
  assert.deepEqual(computerAppOptions({ allowAlways: false }), [
    {
      label: { key: 'Allow once', values: undefined },
      answer: { kind: 'computer_app', decision: 'once' },
    },
    {
      label: { key: 'Allow for this session', values: undefined },
      answer: { kind: 'computer_app', decision: 'session' },
    },
    {
      label: { key: 'Deny', values: undefined },
      answer: { kind: 'computer_app', decision: 'deny' },
    },
  ]);
  assert.deepEqual(computerAppOptions({ allowAlways: true }), [
    {
      label: { key: 'Allow once', values: undefined },
      answer: { kind: 'computer_app', decision: 'once' },
    },
    {
      label: { key: 'Allow for this session', values: undefined },
      answer: { kind: 'computer_app', decision: 'session' },
    },
    {
      label: { key: 'Always allow', values: undefined },
      answer: { kind: 'computer_app', decision: 'always' },
    },
    {
      label: { key: 'Deny', values: undefined },
      answer: { kind: 'computer_app', decision: 'deny' },
    },
  ]);
});

test('terminal application risk remains explicitly unknown until trusted metadata says otherwise', () => {
  for (const risk of [null, undefined]) {
    assert.deepEqual(computerAppRiskMessage(risk), {
      key: 'Application risk is unknown. Review its identity before allowing access.',
      values: undefined,
    });
  }
  assert.deepEqual(computerAppRiskMessage('high'), {
    key: 'Application risk: high',
    values: undefined,
  });
  assert.deepEqual(computerAppRiskMessage('low'), {
    key: 'Application risk: low',
    values: undefined,
  });
});
