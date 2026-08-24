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
import { it } from 'node:test';

import {
  formatWriteStdinPermissionInspection,
  projectToolActivityArgs,
  projectWriteStdinPermissionSummary,
  projectWriteStdinInput,
  WRITE_STDIN_INPUT_PREVIEW_MAX_CHARS,
  WRITE_STDIN_REF_PREVIEW_MAX_CHARS,
} from '../tool-activity-args.js';

it('formats exact terminal input as inert, unambiguous escaped text', () => {
  assert.equal(
    formatWriteStdinPermissionInspection({ input: 'a\\r\r"' }),
    String.raw`input: "a\\r\r\""`,
  );
  assert.equal(
    formatWriteStdinPermissionInspection({ input: '\u001b\u202E中' }),
    String.raw`input: "\u{001B}\u{202E}中"`,
  );
  assert.equal(
    formatWriteStdinPermissionInspection({ input: '\u0085\u2028\uD800' }),
    String.raw`input: "\u{0085}\u{2028}\u{D800}"`,
  );
  assert.equal(
    formatWriteStdinPermissionInspection({ input: '\uFE0F\u034F' }),
    String.raw`input: "\u{FE0F}\u{034F}"`,
  );
});

it('derives a bounded summary and a complete inert WriteStdin permission inspection', () => {
  const suffix = '\u001b[31mrm -rf /tmp/example\r';
  const args = {
    ref: `maka://runtime/background-tasks/${'r'.repeat(200)}`,
    input: `token=secret-value ${'x'.repeat(200)}${suffix}`,
    size: { cols: 120, rows: 40 },
  };

  const summary = projectWriteStdinPermissionSummary(args);
  assert.equal(summary.ref?.truncated, true);
  assert.equal(summary.input?.truncated, true);
  assert.equal(summary.input?.text.includes('secret-value'), false);
  assert.equal(summary.input?.text.includes('rm -rf'), false);
  assert.deepEqual(summary.size, { cols: 120, rows: 40 });

  const inspection = formatWriteStdinPermissionInspection(args);
  assert.ok(inspection?.includes(String.raw`\u{001B}[31mrm -rf /tmp/example\r`));
  assert.ok(inspection?.includes('secret-value'));
  assert.ok(inspection?.includes('size: 120x40'));
  assert.equal(inspection?.includes('\u001b'), false);
});

it('projects WriteStdin activity to a bounded human-readable input preview', () => {
  const projected = projectToolActivityArgs('WriteStdin', {
    ref: 'maka://runtime/background-tasks/one',
    input: '中\r',
    size: { cols: 100, rows: 30 },
  });
  assert.deepEqual(projected, {
    ref: 'maka://runtime/background-tasks/one',
    inputPreview: { text: '中\\r', bytes: 4, truncated: false },
    size: { cols: 100, rows: 30 },
  });
  assert.doesNotMatch((projected as { inputPreview: { text: string } }).inputPreview.text, /\r/);
  assert.deepEqual(projectToolActivityArgs('WriteStdin', projected), projected);
  assert.deepEqual(projectToolActivityArgs('WriteStdin', 'malformed raw input'), {});

  const invalidSize = {
    ref: 'maka://runtime/background-tasks/one',
    size: { cols: 1.5, rows: Number.POSITIVE_INFINITY },
  };
  assert.deepEqual(projectToolActivityArgs('WriteStdin', invalidSize), {
    ref: 'maka://runtime/background-tasks/one',
  });
  assert.equal(projectWriteStdinPermissionSummary(invalidSize).size, undefined);
});

it('projects ordered terminal actions without exposing encoded control bytes', () => {
  const args = {
    ref: 'maka://runtime/background-tasks/one',
    actions: [
      { type: 'key', key: 'b', modifiers: ['ctrl'], text: null },
      { type: 'text', text: 'c', key: null, modifiers: null },
      {
        type: 'mouse',
        event: 'click',
        button: 'left',
        x: 2,
        y: 3,
        text: null,
        key: null,
        direction: null,
        modifiers: null,
      },
    ],
    size: { cols: 0, rows: 0 },
  };

  assert.deepEqual(projectToolActivityArgs('WriteStdin', args), {
    ref: args.ref,
    inputPreview: {
      text: 'Ctrl-B → "c" → Click Left @ (2, 3)',
      bytes: 20,
      truncated: false,
    },
  });
  assert.equal(
    formatWriteStdinPermissionInspection(args),
    'ref: "maka://runtime/background-tasks/one"\n' +
      'actions: { key: Ctrl-B } -> { text: "c" } -> { mouse: Click Left @ (2, 3) }',
  );
});

it('names terminal controls, redacts secrets, escapes invisible input, and caps previews', () => {
  assert.deepEqual(projectWriteStdinInput('\u0003'), {
    text: 'Ctrl-C',
    bytes: 1,
    truncated: false,
  });
  assert.deepEqual(projectWriteStdinInput('password=super-secret\n'), {
    text: 'password=[redacted]\\n',
    bytes: 22,
    truncated: false,
  });
  assert.deepEqual(projectWriteStdinInput('a\u202Eb'), {
    text: 'a\\u{202E}b',
    bytes: 5,
    truncated: false,
  });

  const long = projectWriteStdinInput('x'.repeat(WRITE_STDIN_INPUT_PREVIEW_MAX_CHARS + 20));
  assert.equal(long.text, 'x'.repeat(WRITE_STDIN_INPUT_PREVIEW_MAX_CHARS));
  assert.equal(long.bytes, WRITE_STDIN_INPUT_PREVIEW_MAX_CHARS + 20);
  assert.equal(long.truncated, true);
});

it('rejects projected previews that bypass the display safety boundary', () => {
  const ref = 'maka://runtime/background-tasks/one';
  for (const text of [
    'spoofed\nrow',
    'password=not-redacted',
    'x'.repeat(WRITE_STDIN_INPUT_PREVIEW_MAX_CHARS + 1),
  ]) {
    assert.deepEqual(
      projectToolActivityArgs('WriteStdin', {
        ref,
        inputPreview: { text, bytes: 20, truncated: false },
      }),
      { ref },
    );
  }
});

it('bounds a malformed WriteStdin ref at the human projection boundary', () => {
  const projected = projectToolActivityArgs('WriteStdin', {
    ref: 'x'.repeat(WRITE_STDIN_REF_PREVIEW_MAX_CHARS + 20),
    input: '\r',
  }) as { ref: string };

  assert.equal(Array.from(projected.ref).length, WRITE_STDIN_REF_PREVIEW_MAX_CHARS);
  assert.equal(projected.ref.endsWith('...'), true);
});
