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

test('code, links, URLs, HTML and escapes stay byte-identical while the prose next to them is fixed', () => {
  const cases = [
    ['`**回升：**如果` 与 **回升：**如果', '`**回升：**如果` 与 **回升**：如果'],
    ['`代码` **丙：**丁', '`代码` **丙**：丁'],
    ['**甲：**乙 <b>丙</b>', '**甲**：乙 <b>丙</b>'],
    ['**甲：**乙 \\* 丙', '**甲**：乙 \\* 丙'],
    ['![图](a.png) **甲：**乙', '![图](a.png) **甲**：乙'],
    [
      '[查看](https://example.test/**path:**next) **甲：**乙',
      '[查看](https://example.test/**path:**next) **甲**：乙',
    ],
    [
      '见 https://example.test/**path:**next 这里 **甲：**乙',
      '见 https://example.test/**path:**next 这里 **甲**：乙',
    ],
  ];
  for (const [input, expected] of cases) assert.equal(closeCjkEmphasis(input), expected, input);
  // Nothing to fix: the protected construct is all there is.
  for (const text of [
    '[查看](https://example.test/**path:**next)',
    '<https://example.test/**a:**b>',
    '[ref]: https://example.test/**x:**y',
    '`line one\n**原文：**继续\nline three`',
    '``a`**原文：**继续``',
  ])
    assert.equal(closeCjkEmphasis(text), text, text);
});

test('code blocks stay as written, including nested and look-alike fences', () => {
  for (const text of [
    '```md\n**回升能否守住：**如果\n```',
    '~~~\n**甲：**乙\n~~~',
    '    **原文：**继续',
    // An inner fence with an info string does not close the outer one.
    '````markdown\n```python\n**重点：**这是代码示例\n```\n````',
    // A fence line with text after it does not close the block.
    '```md\nalpha\n``` not a closing fence\n**原文：**继续\n```',
    // A closing fence needs a run at least as long as the opening one.
    '````\n```\n**甲：**乙\n````',
  ])
    assert.equal(closeCjkEmphasis(text), text, text);
  assert.equal(
    closeCjkEmphasis('```md\n**甲：**乙\n```\n**丙：**丁'),
    '```md\n**甲：**乙\n```\n**丙**：丁',
  );
  // Triple backticks that are an inline span, not a fence.
  assert.equal(
    closeCjkEmphasis('```foo``` 是内联代码\n**甲：**乙'),
    '```foo``` 是内联代码\n**甲**：乙',
  );
});

test('lists, quotes and tables with code or links are fixed item by item', () => {
  const cases = [
    [
      '- **回升能否守住：**如果很快跌回 `3200` 下方则偏弱\n- **量能配合：**成交额需持续放大',
      '- **回升能否守住**：如果很快跌回 `3200` 下方则偏弱\n- **量能配合**：成交额需持续放大',
    ],
    [
      '- **回升能否守住：**如果很快跌回\n- **参考来源：**详见 [日报](https://example.com)',
      '- **回升能否守住**：如果很快跌回\n- **参考来源**：详见 [日报](https://example.com)',
    ],
    [
      '- **主线方向：**关注半导体\n    - **细分环节：**设备与材料优先',
      '- **主线方向**：关注半导体\n    - **细分环节**：设备与材料优先',
    ],
    ['> **结论：**短线观望为主', '> **结论**：短线观望为主'],
    ['- [x] **第一步：**已完成配置', '- [x] **第一步**：已完成配置'],
    ['**回撤控制：**若单日跌幅 >5% 则减仓', '**回撤控制**：若单日跌幅 >5% 则减仓'],
  ];
  for (const [input, expected] of cases) assert.equal(closeCjkEmphasis(input), expected, input);
});

test('wrappers move out as a pair and nothing is half bold', () => {
  assert.equal(
    closeCjkEmphasis('他说**“不行”**。详见**《操作指南》**，当前状态**【正常】**'),
    '他说“**不行**”。详见《**操作指南**》，当前状态【**正常**】',
  );
  assert.equal(
    closeCjkEmphasis('这是 **“核心指标”**需要重点关注'),
    '这是 “**核心指标**”需要重点关注',
  );
  // A bracket that closes inside the bold text cannot be separated from its opener: unchanged.
  assert.equal(closeCjkEmphasis('**营收（同比 +12%）**增长明显'), '**营收（同比 +12%）**增长明显');
  // A unit is not clause punctuation and is never peeled out.
  assert.equal(closeCjkEmphasis('**增长12%**明显'), '**增长12%**明显');
});

test('a literal ** is not paired with a real opener', () => {
  assert.equal(
    closeCjkEmphasis('计算 2 ** 3 之后，**结论：**成立'),
    '计算 2 ** 3 之后，**结论**：成立',
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
