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
import { describe, test } from 'node:test';
import {
  cleanGeneratedSessionTitle,
  fallbackSessionTitle,
  sessionTitleSource,
} from '../server/session-title.js';

describe('session title helper', () => {
  test('uses display text, strips system reminders, and truncates input on a UTF-8 boundary', () => {
    const source = sessionTitleSource({
      text: 'model envelope',
      displayText: `<system-reminder>secret</system-reminder>\n${'🦊'.repeat(3_000)}`,
    });

    assert.equal(source.includes('secret'), false);
    assert.equal(new TextEncoder().encode(source).length <= 8 * 1024, true);
    assert.equal(source.endsWith('�'), false);
  });

  test('extracts the user message from a raw skill envelope', () => {
    assert.equal(
      sessionTitleSource({
        text: 'Skills loaded below.\n<invoked-skill id="research">\nSECRET INSTRUCTIONS\n</invoked-skill>\n<user-message>\nAnalyze this code\n</user-message>',
      }),
      'Analyze this code',
    );
  });

  test('builds fallback from the first non-empty line without splitting Unicode code points', () => {
    const line = `${'🦊'.repeat(42)}tail`;
    assert.equal(fallbackSessionTitle(`\n \n${line}\nignored`), '🦊'.repeat(42));
    assert.equal(fallbackSessionTitle(' \n\t'), undefined);
  });

  test('cleans model reasoning, prefixes, quotes, and extra lines', () => {
    assert.equal(
      cleanGeneratedSessionTitle(
        '<think>reasoning</think>\nTitle: "Production log analysis"\nextra',
      ),
      'Production log analysis',
    );
    assert.equal(cleanGeneratedSessionTitle('「生产日志分析」'), '生产日志分析');
  });

  test('refuses model output that carries no usable name', () => {
    assert.equal(cleanGeneratedSessionTitle('<think>x</think>'), undefined);
    assert.equal(cleanGeneratedSessionTitle('   \n\t'), undefined);
  });
});
