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

// Chromium owns image requests and CSP enforcement; fake DOM tests cannot
// detect an allowed Markdown URL that the desktop policy blocks.
// Run after building @maka/ui: node --test packages/ui/scripts/markdown-images.browser.test.mjs
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { transformSync } from 'esbuild';

// A narrow allocation/CPU regression benchmark, not a browser frame-rate claim.
const root = fileURLToPath(new URL('../../../', import.meta.url));
const path = 'packages/ui/src/markdown-body.tsx';
const baseline = process.argv[2] ?? 'HEAD';
const previous = execFileSync('git', ['show', `${baseline}:${path}`], { cwd: root, encoding: 'utf8' });
const current = readFileSync(new URL('../src/markdown-body.tsx', import.meta.url), 'utf8');
function compile(source) {
  const start = source.indexOf('export const MAX_AUTOMATIC_MERMAID_DIAGRAMS');
  const end = source.indexOf('// Whether the prose', start);
  if (start < 0 || end < 0) throw new Error('Diagram budget boundary not found');
  const { code } = transformSync(source.slice(start, end), { loader: 'ts', format: 'cjs', target: 'es2022' });
  const context = { module: { exports: {} }, exports: {} };
  vm.runInNewContext(code, context);
  return context.module.exports.applyMermaidRenderBudget;
}
const before = compile(previous), after = compile(current);
const cases = {
  prose: 'Some ordinary message text, with no diagram.\n'.repeat(150),
  images: '![Screenshot](/tmp/result.png)\n\n'.repeat(30),
  code: '```ts\nconst x = 1;\n```\n\n'.repeat(30),
  mermaid: '```mermaid\ngraph TD; A-->B\n```\n\n'.repeat(5),
};
function run(fn, source) {
  const start = performance.now();
  for (let i = 0; i < 3000; i++) fn(source);
  return performance.now() - start;
}
for (const [name, source] of Object.entries(cases)) {
  for (let i = 0; i < 500; i++) { before(source); after(source); }
  const first = [], second = [];
  for (let i = 0; i < 7; i++) {
    if (i % 2) { second.push(run(after, source)); first.push(run(before, source)); }
    else { first.push(run(before, source)); second.push(run(after, source)); }
  }
  first.sort((a, b) => a - b); second.sort((a, b) => a - b);
  console.log(JSON.stringify({ case: name, iterations: 3000, baseline, beforeMs: first[3], afterMs: second[3], ratio: second[3] / first[3] }));
}
