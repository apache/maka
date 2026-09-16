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

import { planTextHasLineBreak, singleLinePlanText } from '../plan.js';

test('every character that ends a line counts as a Plan line break', () => {
  for (const lineBreak of ['\n', '\r', '\r\n', '\u0085', '\u2028', '\u2029']) {
    assert.equal(
      planTextHasLineBreak(`Implement${lineBreak}the fix`),
      true,
      `${JSON.stringify(lineBreak)} ends a line`,
    );
  }
  // Whitespace that does not end a line is not a break: a title may keep it.
  for (const whitespace of [' ', '\t', '\u00a0', '\u3000']) {
    assert.equal(
      planTextHasLineBreak(`Implement${whitespace}the fix`),
      false,
      `${JSON.stringify(whitespace)} does not end a line`,
    );
  }
  assert.equal(planTextHasLineBreak('Implement the fix'), false);
});

test('single-line Plan text collapses a break and its surrounding whitespace', () => {
  assert.equal(singleLinePlanText('Implement\nthe fix'), 'Implement the fix');
  assert.equal(singleLinePlanText('Implement\r\n  the fix'), 'Implement the fix');
  assert.equal(singleLinePlanText('Implement\n\n\nthe fix'), 'Implement the fix');
  assert.equal(singleLinePlanText('\nImplement the fix\n'), 'Implement the fix');
  assert.equal(singleLinePlanText('Implement\u2028the\u0085fix'), 'Implement the fix');
  // Text that already fits on one line is returned trimmed, not rewritten.
  assert.equal(singleLinePlanText('  Implement the fix  '), 'Implement the fix');
  assert.equal(singleLinePlanText('Implement the fix'), 'Implement the fix');
});
