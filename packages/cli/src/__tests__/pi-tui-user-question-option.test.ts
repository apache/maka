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
import { visibleWidth } from '@earendil-works/pi-tui';
import type { TUI } from '@earendil-works/pi-tui';
import {
  clampRowsWithEllipsis,
  formatUserQuestionOptionRow,
  UserQuestionOverlay,
} from '../pi-tui-pickers.js';
import { ansi, stripAnsi } from '../tui-ansi.js';

// SGR reverse degrades to identity when the terminal reports no color support
// (piped CI), so the highlight assertion keys off this build's actual behavior.
const REVERSE_ON = '\u001b[7m';
const COLOR_ENABLED = ansi.reverse('').length > 0;

test('long options wrap within the row width instead of truncating (#4610)', () => {
  const option = {
    label: '默认省略 + 优雅降级(推荐)',
    description:
      '用户没改默认值就不带新字段(任何版本 Host 都能存);改了才带,旧 Host 拒绝时映射成本地化提示。不动 epoch,远程旧 Host 场景不 break。',
  };
  const rows = formatUserQuestionOptionRow(option, false, 40);
  assert.ok(rows.length > 1, 'expected the option to wrap onto multiple rows');
  for (const row of rows) {
    assert.ok(visibleWidth(row) <= 40, `row exceeds width: ${JSON.stringify(row)}`);
  }
  // No content is lost: the wrapped rows still carry the full label +
  // description. Whitespace is collapsed away because wrap points may fall
  // mid-fragment (CJK has no spaces to break on).
  const squash = (value: string) => value.replace(/\s+/g, '');
  const text = squash(rows.map((row) => stripAnsi(row)).join(''));
  assert.ok(
    text.includes(squash(`${option.label}  ${option.description}`)),
    'label + description survive wrapping intact',
  );
});

test('continuation lines align under the option body, only the first carries the marker', () => {
  const rows = formatUserQuestionOptionRow(
    { label: 'a'.repeat(30), description: 'b'.repeat(30) },
    false,
    20,
  );
  assert.ok(rows.length > 1);
  assert.ok(stripAnsi(rows[0] ?? '').startsWith('  '));
  for (const row of rows.slice(1)) {
    assert.ok(
      stripAnsi(row).startsWith('  '),
      `continuation must indent past the marker column: ${JSON.stringify(row)}`,
    );
  }
});

test('the active row highlights every wrapped line and keeps the arrow marker', () => {
  const option = { label: 'c'.repeat(30), description: 'd'.repeat(30) };
  const rows = formatUserQuestionOptionRow(option, true, 20);
  assert.ok(rows.length > 1);
  assert.ok(stripAnsi(rows[0] ?? '').startsWith('→ '));
  // Exact band coverage, color-level independent: each emitted row must equal
  // the ansi module's own reverse of its plain text (identity when colorless,
  // SGR-wrapped otherwise) — a band that covers only part of the row fails.
  for (const row of rows) {
    assert.equal(row, ansi.reverse(stripAnsi(row)), 'highlight band must cover the whole row');
  }
  if (COLOR_ENABLED) {
    for (const row of rows) {
      assert.ok(row.includes(REVERSE_ON), `active line must be reversed: ${JSON.stringify(row)}`);
    }
  }
});

test('the dim description style re-opens on every wrapped line', () => {
  if (!COLOR_ENABLED) return;
  const option = { label: 'ab', description: '描'.repeat(40) };
  const rows = formatUserQuestionOptionRow(option, false, 20);
  assert.ok(rows.length > 1);
  for (const row of rows.slice(1)) {
    assert.ok(
      row.includes('\u001b[2m'),
      `wrapped description line lost its dim: ${JSON.stringify(row)}`,
    );
  }
});

test('over-budget rows clamp with a visible ellipsis and stay within width', () => {
  const option = {
    label: '默认省略 + 优雅降级(推荐)',
    description: '用户没改默认值就不带新字段'.repeat(10),
  };
  const rows = formatUserQuestionOptionRow(option, false, 30);
  assert.ok(rows.length > 3);
  const clamped = clampRowsWithEllipsis(rows, 2, 30);
  assert.equal(clamped.length, 2);
  assert.ok(
    stripAnsi(clamped[1] ?? '')
      .trimEnd()
      .endsWith('…'),
  );
  for (const row of clamped) {
    assert.ok(visibleWidth(row) <= 30, `clamped row exceeds width: ${JSON.stringify(row)}`);
  }
  // The clamp marker survives the active (reversed) variant too.
  const activeClamped = clampRowsWithEllipsis(formatUserQuestionOptionRow(option, true, 30), 1, 30);
  assert.equal(activeClamped.length, 1);
  assert.ok(
    stripAnsi(activeClamped[0] ?? '')
      .trimEnd()
      .endsWith('…'),
  );
  assert.ok(visibleWidth(activeClamped[0] ?? '') <= 30);
  // Rows already within budget pass through untouched.
  assert.deepEqual(clampRowsWithEllipsis(rows, rows.length, 30), rows);
});

test('short options stay on one row; options without a description render the label only', () => {
  const single = formatUserQuestionOptionRow({ label: '短选项' }, false, 40);
  assert.equal(single.length, 1);
  assert.equal(stripAnsi(single[0] ?? '').trim(), '短选项');
});

test('degenerate widths still emit one padded row per wrapped segment', () => {
  const rows = formatUserQuestionOptionRow({ label: 'x' }, false, 1);
  assert.ok(rows.length >= 1);
  for (const row of rows) {
    assert.ok(visibleWidth(row) <= 1);
  }
});

test('render() respects the row budget: every option, input row, and divider survive', () => {
  const long = {
    label: '默认省略 + 优雅降级(推荐)',
    description: '用户没改默认值就不带新字段'.repeat(12),
  };
  // The Editor only stores the tui reference at construction; render() with an
  // option highlighted never calls editor.render, so a stub suffices.
  const overlay = new UserQuestionOverlay({} as unknown as TUI, {
    title:
      '你想怎么处理 runtime-parametric field(如 platform)在 SettingSnapshot 中的序列化兼容性?'.repeat(
        3,
      ),
    rightLabel: '1 / 1',
    hint: '↑↓ move · type to answer · Enter select · Esc unanswered',
    placeholder: 'Other: type your answer…',
    options: [long, long, long],
    maxRows: () => 12,
    onSelectOption: () => undefined,
    onSubmitText: () => undefined,
    onSkip: () => undefined,
  });
  const lines = overlay.render(50);
  assert.ok(lines.length <= 12, `over budget: ${lines.length} rows`);
  const plain = lines.map((line) => stripAnsi(line));
  // Chrome survives: hint, the free-text input row, and the closing divider.
  assert.ok(
    plain.some((line) => line.includes('↑↓ move')),
    'hint must render',
  );
  assert.ok(
    plain.some((line) => line.includes('Other: type your answer')),
    'input row must render',
  );
  assert.ok(plain[plain.length - 1]?.startsWith('---'), 'divider must close the overlay');
  // Every option still has a visible, selectable row.
  const optionRows = plain.filter((line) => line.includes('默认省略'));
  assert.equal(optionRows.length, 3, 'each option keeps at least its first row');
  // The elision is visible, and the title was capped at two lines.
  assert.ok(
    plain.some((line) => line.includes('…')),
    'clamped rows must show an ellipsis',
  );
  const hintIndex = plain.findIndex((line) => line.includes('↑↓ move'));
  assert.ok(hintIndex <= 3, `title must cap at two lines, hint found at row ${hintIndex}`);
});

test('render() without a budget renders every wrapped line', () => {
  const overlay = new UserQuestionOverlay({} as unknown as TUI, {
    title: 't',
    rightLabel: '1 / 1',
    hint: 'h',
    placeholder: 'Other: type your answer…',
    options: [{ label: 'x'.repeat(50), description: 'd'.repeat(200) }],
    onSelectOption: () => undefined,
    onSubmitText: () => undefined,
    onSkip: () => undefined,
  });
  const lines = overlay.render(40);
  const optionRows = lines.map(stripAnsi).filter((line) => line.includes('ddd'));
  assert.ok(optionRows.length > 3, 'no clamping without a budget');
  assert.ok(!optionRows.some((line) => line.includes('…')), 'nothing elided without a budget');
});
