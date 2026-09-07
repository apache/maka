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

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assembleMainSessionSystemPrompt } from '../system-prompt/main-session-prompt.js';

test('main-session prompt distinguishes progress updates from runtime activity and final output', () => {
  const prompt = assembleMainSessionSystemPrompt(['Project instructions']);

  assert.match(prompt, /progress update before the first non-trivial tool call/);
  assert.match(prompt, /concrete area you will inspect or change/);
  assert.match(prompt, /concrete finding or completed milestone/);
  assert.match(prompt, /never more than two short sentences/);
  assert.match(prompt, /Avoid empty narration/);
  assert.match(prompt, /before the next tool call in the same response/);
  assert.match(prompt, /Do not end a response after merely saying what you will do/);
  assert.doesNotMatch(prompt, /ProgressUpdate/);
  assert.match(
    prompt,
    /Do not expose hidden reasoning or repeat commands, tool names, counts, durations/,
  );
  assert.match(prompt, /exactly one obvious, quick tool call/);
  assert.match(prompt, /distinct final answer/);
  assert.match(prompt, /Project instructions$/);
});
