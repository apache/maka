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

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const DESKTOP_ROOT = resolve(dirname(SCRIPT_PATH), '..');
const LEDGER_PATH = join(DESKTOP_ROOT, 'e2e-budget.json');
const E2E_ROOT = join(DESKTOP_ROOT, 'e2e');

// Playwright forms that create a test, and the ones that only configure a file.
// Anything else at column 0 is an unrecognised form, and the count would be a
// guess -- `test.describe` in particular nests its tests where this scanner
// cannot see them, so it is refused rather than silently undercounted.
const TEST_FORMS = new Set(['test', 'test.only', 'test.skip', 'test.fixme']);
const CONFIG_FORMS = new Set([
  'test.setTimeout',
  'test.use',
  'test.slow',
  'test.beforeAll',
  'test.beforeEach',
  'test.afterAll',
  'test.afterEach',
]);

export function countSpecTests(source, file) {
  let tests = 0;
  for (const [index, line] of source.split(/\r?\n/u).entries()) {
    const match = /^(test(?:\.[A-Za-z]+)?)\s*\(/u.exec(line);
    if (!match) continue;
    const form = match[1];
    if (TEST_FORMS.has(form)) tests += 1;
    else if (!CONFIG_FORMS.has(form)) {
      throw new Error(
        `${file}:${index + 1}: unrecognised top-level \`${form}(\` -- teach check-e2e-budget.mjs how many tests it creates`,
      );
    }
  }
  return tests;
}

export function collectSpecs(root = E2E_ROOT) {
  const specs = {};
  for (const file of readdirSync(root).sort()) {
    if (!file.endsWith('.spec.ts')) continue;
    specs[file] = countSpecTests(readFileSync(join(root, file), 'utf8'), file);
  }
  return specs;
}

export function compare(ledger, actual) {
  const violations = [];
  const recorded = ledger.specs ?? {};
  for (const file of Object.keys(actual)) {
    if (!(file in recorded)) {
      violations.push(`${file}: not in the budget -- add it with a reason it needs a real window`);
      continue;
    }
    const entry = recorded[file];
    if (entry.tests !== actual[file]) {
      violations.push(`${file}: budget records ${entry.tests} test(s), the file has ${actual[file]}`);
    }
    if (typeof entry.electron !== 'string' || entry.electron.trim() === '') {
      violations.push(`${file}: no reason recorded for needing a real Electron window`);
    }
  }
  for (const file of Object.keys(recorded)) {
    if (!(file in actual)) violations.push(`${file}: in the budget but no longer on disk`);
  }
  return violations;
}

function render(ledger, actual) {
  const specs = {};
  for (const file of Object.keys(actual).sort()) {
    specs[file] = {
      tests: actual[file],
      electron: ledger.specs?.[file]?.electron ?? '',
    };
  }
  return `${JSON.stringify({ ...ledger, specs }, null, 2)}\n`;
}

function main(argv) {
  const write = argv.includes('--write');
  if (!write && !argv.includes('--check')) {
    throw new Error('usage: check-e2e-budget.mjs [--check | --write]');
  }
  const ledger = JSON.parse(readFileSync(LEDGER_PATH, 'utf8'));
  const actual = collectSpecs();
  if (write) {
    writeFileSync(LEDGER_PATH, render(ledger, actual));
    console.log('E2E budget updated; fill in any empty `electron` reason by hand.');
    return;
  }
  const violations = compare(ledger, actual);
  if (violations.length === 0) {
    const total = Object.values(actual).reduce((sum, count) => sum + count, 0);
    console.log(`E2E budget holds: ${total} tests in ${Object.keys(actual).length} files.`);
    return;
  }
  console.error(
    [
      'The Electron E2E tier drifted from apps/desktop/e2e-budget.json:',
      ...violations.map((line) => `- ${line}`),
      '',
      ...(ledger.policy ?? []),
      '',
      'Counts: npm run check:e2e-budget:write',
    ].join('\n'),
  );
  process.exit(1);
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_PATH) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
