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
import { passageSnippet, recallTermsFor, type RecallSearchPassage } from '../search-modal.js';

function passage(
  messages: RecallSearchPassage['messages'],
): RecallSearchPassage {
  return {
    sessionId: 's1',
    sessionTitle: 'title',
    anchorMessageId: 'a',
    sequence: 0,
    messages,
    matchedTerms: [],
    score: 1,
  };
}

function message(text: string, isAnchor: boolean): RecallSearchPassage['messages'][number] {
  return {
    messageId: `m-${text}`,
    role: 'user',
    matchKind: 'user_message',
    text,
    timestamp: 1,
    isAnchor,
  };
}

test('a typed phrase becomes the distinct terms recall matches', () => {
  // Recall matches literal terms, OR-combined, so a sentence is most useful as
  // its words. This is the user-visible behavior change of the recall lane.
  assert.deepEqual(recallTermsFor('deploy script'), ['deploy', 'script']);
  assert.deepEqual(recallTermsFor('  部署   脚本  '), ['部署', '脚本']);
  // A repeated word is one term, not a repeated vote for it.
  assert.deepEqual(recallTermsFor('deploy deploy'), ['deploy']);
  assert.deepEqual(recallTermsFor('single'), ['single']);
});

test('an empty or whitespace query produces no terms', () => {
  assert.deepEqual(recallTermsFor(''), []);
  assert.deepEqual(recallTermsFor('   '), []);
});

test('terms are capped so a pasted paragraph cannot become an unbounded query', () => {
  const many = Array.from({ length: 40 }, (_unused, index) => `w${index}`).join(' ');
  assert.equal(recallTermsFor(many).length, 8);
});

test('a passage snippet is the anchor text, which is what recall matched on', () => {
  assert.equal(
    passageSnippet(passage([message('context', false), message('the answer', true)])),
    'the answer',
  );
});

test('a file-only anchor falls back to the first text the passage carries', () => {
  // A message whose whole content was a pasted file has no text of its own;
  // showing nothing would hide the hit the user searched for.
  assert.equal(
    passageSnippet(passage([message('', true), message('surrounding words', false)])),
    'surrounding words',
  );
  assert.equal(passageSnippet(passage([message('', true)])), '');
});
