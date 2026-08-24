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
import { describe, test } from 'node:test';
import {
  EXTERNAL_SESSION_QUERY_TEXT_MAX_CHARS,
  externalSessionMatchesQuery,
  normalizeExternalSessionQueryText,
  sameExternalSessionPath,
  type ExternalSessionSummary,
} from '../external-session.js';

function summary(over: Partial<ExternalSessionSummary> = {}): ExternalSessionSummary {
  return { id: 'sess-1', name: 'Fix the parser', cwd: '/Users/z/maka-agent', ...over };
}

describe('externalSessionMatchesQuery', () => {
  test('an absent term selects everything', () => {
    assert.equal(externalSessionMatchesQuery(summary()), true);
    assert.equal(externalSessionMatchesQuery(summary(), {}), true);
  });

  test('a term matches the title, case-insensitively', () => {
    assert.equal(externalSessionMatchesQuery(summary(), { text: 'parser' }), true);
    assert.equal(externalSessionMatchesQuery(summary(), { text: 'PARSER' }), true);
    assert.equal(externalSessionMatchesQuery(summary(), { text: 'Fix the' }), true);
  });

  test('a term matches the project path', () => {
    // The other half of "the session I half remember": people navigate by
    // where the work happened as often as by what it was called.
    assert.equal(externalSessionMatchesQuery(summary(), { text: 'maka-agent' }), true);
    assert.equal(externalSessionMatchesQuery(summary(), { text: '/Users/z' }), true);
  });

  test('a term that matches neither excludes the row', () => {
    assert.equal(externalSessionMatchesQuery(summary(), { text: 'kubernetes' }), false);
  });

  test('a blank box is not a filter', () => {
    // A stray space must not hide every session. `''` and `'   '` both mean
    // "no term", which is why the term is normalized rather than truthiness-
    // checked at each call site.
    for (const text of ['', '   ', '\t\n']) {
      assert.equal(externalSessionMatchesQuery(summary(), { text }), true, JSON.stringify(text));
    }
    assert.equal(normalizeExternalSessionQueryText('   '), undefined);
    assert.equal(normalizeExternalSessionQueryText(undefined), undefined);
    assert.equal(normalizeExternalSessionQueryText('  Parser '), 'parser');
  });

  test('an over-long term is truncated rather than refused', () => {
    // Bounded because the term reaches every adapter. Truncating keeps a long
    // paste working on its prefix instead of throwing at the user.
    const term = 'a'.repeat(EXTERNAL_SESSION_QUERY_TEXT_MAX_CHARS + 50);
    const normalized = normalizeExternalSessionQueryText(term);
    assert.equal(normalized?.length, EXTERNAL_SESSION_QUERY_TEXT_MAX_CHARS);
  });

  test('a term pasted from a Windows path finds a forward-slash summary', () => {
    // `sameExternalSessionPath` already calls these the same project. Before
    // the shared normalizer, the text match disagreed with the cwd filter
    // about the same two strings.
    const win = summary({ cwd: 'C:/Repo/App' });
    assert.equal(
      externalSessionMatchesQuery(win, {
        text: 'C:' + String.fromCharCode(92) + 'Repo' + String.fromCharCode(92) + 'App',
      }),
      true,
    );
    assert.equal(externalSessionMatchesQuery(win, { text: 'c:/repo/app' }), true);
    // A summary recorded with backslashes is reachable from either spelling.
    const stored = summary({
      cwd: 'C:' + String.fromCharCode(92) + 'Repo' + String.fromCharCode(92) + 'App',
    });
    assert.equal(externalSessionMatchesQuery(stored, { text: 'C:/Repo/App' }), true);
  });

  test('separator folding stays on the path pair and off the title', () => {
    // Folding a title would make `/n` match a title holding a literal
    // backslash-n; folding the term but not the title would stop the term
    // that names it from finding it. Both directions are checked because a
    // one-sided fold trades one bug for the other.
    const backslash = String.fromCharCode(92);
    const title = summary({ name: `regex: ${backslash}n handling`, cwd: '/repo' });
    assert.equal(externalSessionMatchesQuery(title, { text: `${backslash}n` }), true);
    assert.equal(externalSessionMatchesQuery(title, { text: '/n' }), false);
    // The path pair still folds, which is what makes a pasted Windows path work.
    const win = summary({ name: 'untitled', cwd: 'C:/Repo/App' });
    assert.equal(
      externalSessionMatchesQuery(win, { text: `C:${backslash}Repo${backslash}App` }),
      true,
    );
  });

  test('composed and decomposed Unicode name the same conversation', () => {
    // macOS records decomposed filenames, so the same visible title arrives
    // in NFC or NFD depending on where it was typed.
    const nfc = 'caf\u00e9-notes';
    const nfd = 'cafe\u0301-notes';
    assert.notEqual(nfc, nfd, 'fixture must actually differ by normalization form');
    assert.equal(externalSessionMatchesQuery(summary({ name: nfc }), { text: nfd }), true);
    assert.equal(externalSessionMatchesQuery(summary({ name: nfd }), { text: nfc }), true);
    assert.equal(sameExternalSessionPath('/repo/' + nfc, '/repo/' + nfd), true);
  });

  test('archived rows stay hidden unless asked for, term or no term', () => {
    const archived = summary({ archived: true });
    assert.equal(externalSessionMatchesQuery(archived, {}), false);
    assert.equal(externalSessionMatchesQuery(archived, { text: 'parser' }), false);
    assert.equal(externalSessionMatchesQuery(archived, { includeArchived: true }), true);
    assert.equal(
      externalSessionMatchesQuery(archived, { includeArchived: true, text: 'parser' }),
      true,
    );
  });

  test('cwd and text both apply, not either', () => {
    const query = { cwd: '/Users/z/maka-agent', text: 'parser' };
    assert.equal(externalSessionMatchesQuery(summary(), query), true);
    assert.equal(externalSessionMatchesQuery(summary({ cwd: '/elsewhere' }), query), false);
    assert.equal(externalSessionMatchesQuery(summary({ name: 'unrelated' }), query), false);
  });

  test('a term matching one field is enough', () => {
    assert.equal(
      externalSessionMatchesQuery(summary({ name: 'untitled' }), { text: 'maka-agent' }),
      true,
    );
    assert.equal(externalSessionMatchesQuery(summary({ cwd: '/tmp' }), { text: 'parser' }), true);
  });
});

describe('sameExternalSessionPath', () => {
  test('separators and a trailing slash do not change the project', () => {
    // The Claude Code adapter compared raw strings, so the same project
    // reached through a different separator answered "no such project".
    assert.equal(sameExternalSessionPath('C:/Repo/App', 'C:\\Repo\\App'), true);
    assert.equal(sameExternalSessionPath('/repo/app/', '/repo/app'), true);
    assert.equal(sameExternalSessionPath('/repo/app', '/repo/app'), true);
  });

  test('a Windows drive letter is case-insensitive, a POSIX path is not', () => {
    assert.equal(sameExternalSessionPath('C:/Repo', 'c:/repo'), true);
    // Two different directories on a case-sensitive filesystem.
    assert.equal(sameExternalSessionPath('/Repo', '/repo'), false);
  });

  test('the POSIX root is not the same as an unknown cwd', () => {
    // Stripping trailing separators unconditionally folded `/` and `''` to the
    // same value, so a workspace at filesystem root matched every session
    // whose cwd the adapter could not determine. The root IS its separator.
    assert.equal(sameExternalSessionPath('/', ''), false);
    assert.equal(sameExternalSessionPath('/', '/'), true);
    assert.equal(sameExternalSessionPath('//', '/'), true);
    assert.equal(sameExternalSessionPath('', ''), true);
    assert.equal(sameExternalSessionPath('/', '/repo'), false);
  });

  test('a term with a trailing separator still names the project', () => {
    // Windows Explorer copies `C:\\Repo\\App\\`, trailing backslash included.
    const backslash = String.fromCharCode(92);
    const win = summary({ name: 'untitled', cwd: 'C:/Repo/App' });
    assert.equal(
      externalSessionMatchesQuery(win, {
        text: `C:${backslash}Repo${backslash}App${backslash}`,
      }),
      true,
    );
    assert.equal(
      externalSessionMatchesQuery(summary({ cwd: '/repo/app' }), { text: '/repo/app/' }),
      true,
    );
  });

  test('different projects stay different', () => {
    assert.equal(sameExternalSessionPath('/repo/app', '/repo/other'), false);
    assert.equal(sameExternalSessionPath('/repo/app', '/repo/app-2'), false);
  });
});
