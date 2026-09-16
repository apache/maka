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

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const DESKTOP_ROOT = resolve(dirname(SCRIPT_PATH), '..');
const LEDGER_PATH = join(DESKTOP_ROOT, 'e2e-budget.json');
const E2E_ROOT = join(DESKTOP_ROOT, 'e2e');

// Playwright's own default `testMatch`, because `playwright.config.ts` sets
// `testDir: '.'` and overrides neither: anything this pattern misses would run
// in the tier while the budget stayed silent about it.
const SPEC_PATTERN = /\.(?:spec|test)\.[cm]?[jt]sx?$/u;

// Every spec writes its tests as a bare `test(` at column 0. A dotted top-level
// form would need a counting rule of its own (`test.describe` nests its tests
// where a line scanner cannot see them), and an indented `test(` is a test this
// scanner cannot attribute -- a loop or a helper generating them counts as
// zero. Both are refused rather than silently undercounted.
export function countSpecTests(source, file) {
  let tests = 0;
  for (const [index, line] of source.split(/\r?\n/u).entries()) {
    const top = /^test(\.[A-Za-z]+)?\s*\(/u.exec(line);
    if (top) {
      if (top[1] === undefined) tests += 1;
      else {
        throw new Error(
          `${file}:${index + 1}: unrecognised top-level \`test${top[1]}(\` -- teach check-e2e-budget.mjs how many tests it creates`,
        );
      }
      continue;
    }
    if (/\btest\s*\(/u.test(line)) {
      throw new Error(
        `${file}:${index + 1}: \`test(\` away from column 0 -- check-e2e-budget.mjs cannot count it`,
      );
    }
  }
  return tests;
}

export function collectSpecs(root = E2E_ROOT) {
  const specs = {};
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      if (entry.name === 'node_modules') continue;
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(absolute);
        continue;
      }
      if (!SPEC_PATTERN.test(entry.name)) continue;
      const file = relative(root, absolute).replaceAll('\\', '/');
      specs[file] = countSpecTests(readFileSync(absolute, 'utf8'), file);
    }
  };
  walk(root);
  return specs;
}

export function compare(ledger, actual) {
  const violations = [];
  const recorded = ledger.specs ?? {};
  for (const file of Object.keys(actual)) {
    if (!(file in recorded)) {
      violations.push(
        `${file}: not in the budget (${actual[file]} test(s)) -- add it with a reason it needs a real window`,
      );
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

function main() {
  const ledger = JSON.parse(readFileSync(LEDGER_PATH, 'utf8'));
  const actual = collectSpecs();
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
    ].join('\n'),
  );
  process.exit(1);
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_PATH) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
