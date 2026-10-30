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
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  applyHeader,
  auditTree,
  commentStylesFor,
  HeaderNotWritableError,
  listSourceFiles,
  renderHeader,
} from './asf-license-headers.mjs';

const block = readFileSync(new URL(import.meta.url), 'utf8').split('\n\n', 1)[0] + '\n';
const dash =
  block
    .split('\n')
    .slice(1, -2)
    .map((line) => `--${line.slice(2).replace(/[ \t]+/g, ' ')}`)
    .join('\n') + '\n';

function tree(t, files) {
  const root = mkdtempSync(join(tmpdir(), 'asf-headers-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [path, contents] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), contents);
  }
  return root;
}

test('applying a canonical license preserves declarations and source bytes and is idempotent', () => {
  assert.equal(renderHeader('block'), block);
  for (const [styles, declaration, body] of [
    [['block'], '#!/usr/bin/env node\n', 'main();\n'],
    [['html'], '<!doctype html>\n', '<html></html>\n'],
    [['html'], '---\nname: skill\n---\n', '# Title\n'],
    [['hash'], '', '# a note\nvalue: true\n'],
    [['slash'], '', 'const value = 7;\n'],
    [commentStylesFor('new.sql'), '', 'SELECT 1;\n'],
  ]) {
    const result = applyHeader(declaration + body, styles);
    assert.equal(result, declaration + renderHeader(styles[0]) + '\n' + body);
    assert.equal(applyHeader(result, styles), result);
  }
});

test('existing noncanonical or duplicated licenses are rejected without stacking a new header', () => {
  for (const source of [
    block.replace('http://', 'https://') + '\nmain();\n',
    '/**\n' + block.split('\n').slice(1).join('\n'),
    block + '\n' + block + '\nmain();\n',
    'main();\n' + block,
  ])
    assert.throws(() => applyHeader(source, ['block']), HeaderNotWritableError);
  for (const source of [
    dash.replace('NOTICE', 'NOTICES') + '\nSELECT 1;\n',
    dash.replace('-- Licensed to the Apache Software', '-- Licensed to the Apache\n-- Software') +
      '\nSELECT 1;\n',
    'SELECT 1;\n' + dash,
    block + '\n' + dash + '\nSELECT 1;\n',
    dash.replace('-- with the License.', '// with the License.') + '\nSELECT 1;\n',
  ])
    assert.throws(
      () => applyHeader(source, commentStylesFor('invalid.sql')),
      HeaderNotWritableError,
    );
});

test('an extracted tree audits every file and repairs leave a clean result', (t) => {
  const root = tree(t, {
    'good.rs': block + '\nfn main() {}\n',
    'migrations/current.sql': dash + '\nCREATE TABLE current (id INTEGER);\n',
    'missing.ts': 'const value = 1;\n',
    'noncanonical.py': renderHeader('hash').replace('http://', 'https://') + '\npass\n',
    'duplicated.rs': block + '\n' + block,
    'adapted.rs': block + '\n// Adapted from an upstream project.\n',
    'third-party/sqlx-sqlite/src/new.rs': 'fn added_by_maka() {}\n',
    'third-party/sqlx-sqlite/src/connection/mod.rs': 'upstream source\n',
    'dist/unexpected.kt': 'fun main() {}\n',
    'package.json': '{}\n',
  });
  symlinkSync('good.rs', join(root, 'LINK.md'));
  const report = auditTree({ root });
  assert.equal(report.mode, 'archive');
  const sql = readFileSync(join(root, 'migrations/current.sql'), 'utf8');
  assert.equal(applyHeader(sql, commentStylesFor('migrations/current.sql')), sql);
  assert.equal(report.covered, 7);
  assert.deepEqual(report.missing.sort(), ['missing.ts', 'third-party/sqlx-sqlite/src/new.rs']);
  assert.deepEqual(report.unrecognized, ['noncanonical.py']);
  assert.deepEqual(report.duplicated, ['duplicated.rs']);
  assert.deepEqual(report.unreviewedProvenance, ['adapted.rs']);
  assert.deepEqual(report.unclassified, ['dist/unexpected.kt']);
  assert.deepEqual(report.irregular, ['LINK.md']);
  for (const path of [
    'missing.ts',
    'duplicated.rs',
    'adapted.rs',
    'third-party/sqlx-sqlite/src/new.rs',
  ]) {
    writeFileSync(join(root, path), block + '\nconst value = 1;\n');
  }
  writeFileSync(join(root, 'noncanonical.py'), renderHeader('hash') + '\npass\n');
  rmSync(join(root, 'LINK.md'));
  rmSync(join(root, 'dist/unexpected.kt'));
  const repaired = auditTree({ root });
  for (const key of [
    'missing',
    'unrecognized',
    'duplicated',
    'unreviewedProvenance',
    'unclassified',
    'irregular',
  ]) {
    assert.deepEqual(repaired[key], [], key);
  }
  assert.equal(repaired.covered, 7);
});

test('checkout enumeration includes new source files and omits deleted index entries', (t) => {
  const root = tree(t, { 'removed.rs': block, 'kept.rs': block });
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
  git('init');
  git('add', 'removed.rs', 'kept.rs');
  rmSync(join(root, 'removed.rs'));
  writeFileSync(join(root, 'new.rs'), block);
  assert.deepEqual(listSourceFiles(root).files, ['kept.rs', 'new.rs']);
});
