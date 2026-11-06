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
import { closeCjkEmphasis } from '../app/markdownEmphasis.ts';

test('punctuation inside the end marker moves out when a character follows', () => {
  assert.equal(
    closeCjkEmphasis('- **回升能否守住：**如果很快跌回'),
    '- **回升能否守住**：如果很快跌回',
  );
  assert.equal(closeCjkEmphasis('**Note:**Then text'), '**Note**:Then text');
  assert.equal(closeCjkEmphasis('**重点，**说明'), '**重点**，说明');
});

test('punctuation inside the start marker moves out when a character precedes it', () => {
  assert.equal(closeCjkEmphasis('他说**“不行”**然后'), '他说“**不行**”然后');
});

test('text that already works is left exactly as written', () => {
  for (const text of [
    '**回升能否守住**：如果很快跌回',
    '**回升能否守住：** 如果很快跌回',
    '**重点**说明',
    '**Note:** Then text',
    '**done.**',
    '段落末尾 **加粗：**',
    '**a**b**c**',
    'no bold at all',
  ])
    assert.equal(closeCjkEmphasis(text), text, text);
});

test('a paragraph with code is left entirely as written', () => {
  const fenced = '```md\n**回升能否守住：**如果\n```\n**回升：**如果';
  assert.equal(closeCjkEmphasis(fenced), '```md\n**回升能否守住：**如果\n```\n**回升**：如果');
  assert.equal(
    closeCjkEmphasis('`**回升：**如果` 与 **回升：**如果'),
    '`**回升：**如果` 与 **回升：**如果',
  );
  const tilde = '~~~\n**甲：**乙\n~~~';
  assert.equal(closeCjkEmphasis(tilde), tilde);
  // A code span that runs over lines, and one closed by a longer run of backticks.
  const multiline = '`line one\n**原文：**继续\nline three`';
  assert.equal(closeCjkEmphasis(multiline), multiline);
  const double = '``a`**原文：**继续``';
  assert.equal(closeCjkEmphasis(double), double);
  // Indented code.
  const indented = '    **原文：**继续';
  assert.equal(closeCjkEmphasis(indented), indented);
});

test('links, URLs, HTML and escapes are never rewritten', () => {
  for (const text of [
    '[查看](https://example.test/**path:**next)',
    '见 https://example.test/**path:**next 这里',
    '<https://example.test/**a:**b>',
    '**甲：**乙 <b>丙</b>',
    '**甲：**乙 \\* 丙',
    '![图](a.png) **甲：**乙',
    '[ref]: https://example.test/**x:**y',
  ])
    assert.equal(closeCjkEmphasis(text), text, text);
});

test('a plain paragraph beside a code paragraph is still fixed', () => {
  assert.equal(
    closeCjkEmphasis('**甲：**乙\n\n`代码` **丙：**丁'),
    '**甲**：乙\n\n`代码` **丙：**丁',
  );
});

test('bold made only of punctuation or spaces is not rewritten', () => {
  assert.equal(closeCjkEmphasis('字**：：**字'), '字**：：**字');
  assert.equal(closeCjkEmphasis('a** **b'), 'a** **b');
});

test('every pair on every line is handled, and the result is stable', () => {
  const input = '**甲：**乙\n- **丙，**丁\n他说**“戊”**己';
  const once = closeCjkEmphasis(input);
  assert.equal(once, '**甲**：乙\n- **丙**，丁\n他说“**戊**”己');
  assert.equal(closeCjkEmphasis(once), once);
});
