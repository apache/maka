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

test('code blocks stay as written, including multiline indented and nested fences', () => {
  for (const text of [
    '```md\n**回升能否守住：**如果\n```',
    '~~~\n**甲：**乙\n~~~',
    '    **原文：**继续',
    '示例代码：\n\n    const a = 1;\n    const b = "**原文：**继续";',
    '    const a = 1;\n\n    const b = 2;\n    const c = "**原文：**继续";',
    // Six spaces after a blank line under `- ` is an indented code block inside the list item.
    '- 列表项\n\n      const a = 1;\n      const b = "**原文：**继续";',
    // Thematic break followed by four-space indented code block.
    '- - -\n\n    const a = 1;\n    const b = "**原文：**继续";',
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
  assert.equal(
    closeCjkEmphasis('    const a = 1;\n    const b = "**甲：**乙";\n\n**丙：**丁'),
    '    const a = 1;\n    const b = "**甲：**乙";\n\n**丙**：丁',
  );
  // Triple backticks that are an inline span, not a fence.
  assert.equal(
    closeCjkEmphasis('```foo``` 是内联代码\n**甲：**乙'),
    '```foo``` 是内联代码\n**甲**：乙',
  );
});

test('lists, quotes and tables with code, links or loose continuations are fixed item by item', () => {
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
    [
      '- 项目一\n\n    这是列表项内的缩进续行 **重点：**不是代码块\n    第二行 **结论：**也不是代码块',
      '- 项目一\n\n    这是列表项内的缩进续行 **重点**：不是代码块\n    第二行 **结论**：也不是代码块',
    ],
    ['> **结论：**短线观望为主', '> **结论**：短线观望为主'],
    ['- [x] **第一步：**已完成配置', '- [x] **第一步**：已完成配置'],
    ['**回撤控制：**若单日跌幅 >5% 则减仓', '**回撤控制**：若单日跌幅 >5% 则减仓'],
  ];
  for (const [input, expected] of cases) assert.equal(closeCjkEmphasis(input), expected, input);
});

test('labels ending in brackets, quotes, units, code, links or symbols before punctuation close', () => {
  const cases = [
    ['- **回升（短期）：**如果很快跌回 3200 下方', '- **回升（短期）**：如果很快跌回 3200 下方'],
    ['- **营收增速 (YoY)：**同比增长 12%', '- **营收增速 (YoY)**：同比增长 12%'],
    ['1. **方案 A（推荐）：**直接升级依赖', '1. **方案 A（推荐）**：直接升级依赖'],
    ['- **涨幅 +12%：**创阶段新高', '- **涨幅 +12%**：创阶段新高'],
    ['- **所谓的“核心资产”：**需要结合估值看', '- **所谓的“核心资产”**：需要结合估值看'],
    ['- **检查 `config.toml`：**确认端口配置正确', '- **检查 `config.toml`**：确认端口配置正确'],
    [
      '- **详见 [官方文档](https://example.com)：**按步骤操作',
      '- **详见 [官方文档](https://example.com)**：按步骤操作',
    ],
    ['- **风险提示🔥：**仓位不宜过重', '- **风险提示🔥**：仓位不宜过重'],
    ['请参考**《操作指南》：**按步骤执行', '请参考《**操作指南**》：按步骤执行'],
    ['这是**“核心指标”：**需要重点关注', '这是“**核心指标**”：需要重点关注'],
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
  assert.equal(closeCjkEmphasis('他说**“没问题，”**随后离开'), '他说“**没问题，**”随后离开');
  // Two separate quoted spans do not form a single outer wrapper: unchanged rather than split.
  assert.equal(closeCjkEmphasis('他说**“甲”和“乙”**都是重点'), '他说**“甲”和“乙”**都是重点');
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
  assert.equal(closeCjkEmphasis('指针类型 T**，**结论：**成立'), '指针类型 T**，**结论**：成立');
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
