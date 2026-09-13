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

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const refs = {
  A: '839d14535a541ef0da29ea4d6626a2e3d0e32a8e',
  B: '0039a230754a4bd832653f481194fb40516464db',
  C: '839d14535a541ef0da29ea4d6626a2e3d0e32a8e',
  D: '0039a230754a4bd832653f481194fb40516464db',
  E: '839d14535a541ef0da29ea4d6626a2e3d0e32a8e',
  F: '839d14535a541ef0da29ea4d6626a2e3d0e32a8e',
  V: 'b65a8c16476c61336c87b9838f161886df26c5e1',
  W: 'd79e310d592402b2859227bb1ff3cbcd828ea543',
};
const files = [
  'packages/ui/src/chat-view.tsx',
  'packages/ui/src/use-chat-scroll.ts',
  'packages/ui/src/transcript-scroll-authority.tsx',
  'apps/desktop/src/renderer/platform/desktop/desktop-transcript-range-store.ts',
  'packages/ui/src/use-transcript-known-space.ts',
  // Publication's interface and its consumers must come from the same ref.
  'packages/ui/src/transcript-viewport-navigation.ts',
  'packages/ui/src/__tests__/transcript-scroll-authority.test.ts',
  'packages/ui/src/__tests__/use-chat-scroll.test.tsx',
  'apps/desktop/src/main/__tests__/session-workspace-action-identity.test.ts',
  'apps/desktop/src/main/__tests__/workhub-send-visibility.test.ts',
];
const original = files.map((file) => readFileSync(file));
const output = path.resolve(process.env.MAKA_PERF_OUTPUT ?? 'perf-results');
const run = (command, args, options = {}) =>
  execFileSync(command, args, { stdio: 'inherit', ...options });
const order =
  process.env.MAKA_PERF_VARIANTS?.split(',') ??
  (process.env.MAKA_PERF_DIAGNOSE === '1' ? ['A', 'B'] : ['A', 'B', 'B', 'A', 'A', 'B']);
if (order.some((variant) => !(variant in refs))) throw new Error('Unknown scroll variant');
mkdirSync(output, { recursive: true });
try {
  for (const [index, variant] of order.entries()) {
    for (const file of files) {
      const ref =
        file.endsWith('use-transcript-known-space.ts') && !['V', 'W'].includes(variant)
          ? refs.B
          : refs[variant];
      writeFileSync(file, execFileSync('git', ['show', ref + ':' + file]));
    }
    {
      const file = files[3];
      let source = readFileSync(file, 'utf8');
      source = source.replace(
        'const task = command(false,',
        "performance.mark('perf:transcript-request', { detail: { edge, anchor: at.anchor, maxBytes } });\n    const task = command(false,",
      );
      source = source.replace(
        'if (installed) this.#window = installed;',
        "performance.mark('perf:transcript-answer', { detail: { kind: answer.kind, rows: answer.rows.size, beforeRows: window.order.length, afterRows: installed?.order.length } });\n    if (installed) this.#window = installed;",
      );
      if (variant === 'F') {
        // Diagnostic only: byte budget is not a render-work or viewport budget.
        source = source
          .replace(
            'loadBefore(maxBytes = DESKTOP_TRANSCRIPT_FRAGMENT_MAX_BYTES)',
            'loadBefore(maxBytes = 8192)',
          )
          .replace(
            'loadAfter(maxBytes = DESKTOP_TRANSCRIPT_FRAGMENT_MAX_BYTES)',
            'loadAfter(maxBytes = 8192)',
          );
      }
      writeFileSync(file, source);
    }
    if (variant === 'C' || variant === 'D') {
      const file = files[2];
      const source = readFileSync(file, 'utf8');
      const needle = "pinned ? 'none' : 'auto'";
      if (source.split(needle).length !== 3) throw new Error('Anchor ablation source changed');
      // Diagnostic only: retain manual compensation, freeze native anchoring off.
      // Async content resizing is not covered by this ablation's acceptance.
      writeFileSync(file, source.replaceAll(needle, "'none'"));
    }
    run('npm', ['--workspace', '@maka/ui', 'run', 'build']);
    run('npm', ['--workspace', '@maka/desktop', 'run', 'build:renderer']);
    // Unused virtual mounting helpers remain present on older refs, with no
    // import or call in those bundles.
    const env = {
      ...process.env,
      MAKA_PERF_PAIRED: '1',
      MAKA_PERF_VARIANT: variant,
      MAKA_PERF_SOURCE_COMMIT: refs[variant],
      MAKA_PERF_NO_HAS: variant === 'E' ? '1' : '',
      MAKA_PERF_OUTPUT: path.join(output, index + '-' + variant),
    };
    run(
      'npx',
      [
        'playwright',
        'test',
        '--config',
        '../../scripts/perf/playwright.config.ts',
        'scroll-input.spec.ts',
      ],
      { cwd: 'apps/desktop', env },
    );
  }
} finally {
  files.forEach((file, index) => writeFileSync(file, original[index]));
}
