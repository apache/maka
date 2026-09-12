#!/usr/bin/env node
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

// Ratchet for locale hygiene. Every rule below is a place where adding a
// locale to UI_LOCALES compiles cleanly but silently renders the wrong
// language, because the code branches on a locale literal instead of
// indexing a `UiCatalog`. Only files the diff touches are scanned, so each
// (file, rule) count may shrink but never grow; there is no ledger.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

export const SCOPE = ['apps/desktop/src', 'packages/core/src', 'packages/ui/src'];

// Both quote styles: biome leaves apps/desktop and packages/ui unformatted, so
// `"en"` is as permanent there as `'en'`. Every pattern is global so one line
// with two hits counts two.
export const RULES = {
  // `locale === 'zh-CN' ? a : b` — a fourth locale falls into `b` unnoticed.
  // Narrower than check-tui-copy's AST `locale-branch` (which also sees
  // `switch (locale)` and if-statements) but runs install-free over the
  // desktop, core, and ui trees; the two rules are deliberately distinct.
  'locale-literal-compare':
    /\blocale(?:\.[A-Za-z]+)?\s*(?:===|!==)\s*['"](?:zh(?:-CN|-TW)?|en)['"]|\blocale\.startsWith\(['"]zh['"]\)/gu,
  // `locale: UiLocale = 'zh-CN'` — a caller that forgets the argument gets one language.
  'silent-locale-default': /(?<!\b(?:let|const|var)\s+)\blocale\??:\s*UiLocale\s*=\s*['"]/gu,
  // `/[\u4e00-\u9fff]/.test(message)` — decides the language from the payload.
  'cjk-sniff': /\\u3400-\\u9fff|\\u4e00-\\u9fff|\\u3400-\\u4dbf|\[一-龥\]/giu,
  // `'凭据已保存': '憑證已儲存'` — translating one locale's copy by string lookup.
  'string-keyed-translation': /^\s*['"][㐀-鿿][^'"]*['"]:\s*['"]/gu,
};

const EXCLUDED = /(?:^|\/)(?:__tests__|stories)\/|\.(?:test|stories)\.tsx?$/u;

export function scanSource(source) {
  const hits = [];
  for (const [index, line] of source.split('\n').entries()) {
    for (const [rule, pattern] of Object.entries(RULES)) {
      for (const _match of line.matchAll(pattern)) {
        hits.push({ rule, line: index + 1, text: line.trim() });
      }
    }
  }
  return hits;
}

function countByRule(hits) {
  const counts = {};
  for (const { rule } of hits) counts[rule] = (counts[rule] ?? 0) + 1;
  return counts;
}

export function compare(path, baseSource, currentSource) {
  const hits = scanSource(currentSource);
  const base = countByRule(scanSource(baseSource));
  return Object.entries(countByRule(hits))
    .filter(([rule, count]) => count > (base[rule] ?? 0))
    .map(([rule, count]) => ({
      path,
      rule,
      base: base[rule] ?? 0,
      current: count,
      lines: hits.filter((hit) => hit.rule === rule).map((hit) => `${hit.line}: ${hit.text}`),
    }));
}

function git(args) {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', maxBuffer: 1 << 28 });
}

// Working tree against base, so uncommitted edits are checked too. The 30%
// similarity floor still pairs a file that was rewritten while it moved. The
// diff is not pathspec-limited: a file moved into scope from outside would
// otherwise show as added and lose its base.
function changedFiles(base) {
  return git(['diff', '-M30%', '--name-status', '--diff-filter=AMR', base])
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [status, from, to] = line.split('\t');
      return { path: to ?? from, basePath: status === 'A' ? undefined : from };
    })
    .filter(({ path }) => inScope(path) && /\.tsx?$/u.test(path) && !EXCLUDED.test(path));
}

function inScope(path) {
  return SCOPE.some((dir) => path.startsWith(`${dir}/`));
}

function resolveBase(argv) {
  const index = argv.indexOf('--base');
  if (index >= 0 && argv[index + 1]) return argv[index + 1];
  try {
    return git(['merge-base', 'HEAD', 'origin/main']).trim();
  } catch {
    return undefined;
  }
}

function main(argv) {
  const base = resolveBase(argv);
  if (!base) {
    console.error('Locale hygiene check failed: pass --base <commit> or fetch origin/main.');
    return 1;
  }
  const violations = changedFiles(base).flatMap(({ path, basePath }) =>
    compare(
      path,
      basePath ? git(['show', `${base}:${basePath}`]) : '',
      readFileSync(join(repoRoot, path), 'utf8'),
    ),
  );
  if (violations.length === 0) {
    console.log('Locale hygiene check passed.');
    return 0;
  }
  console.error(
    'Locale hygiene check failed: new locale branches were added. Index a UiCatalog instead.',
  );
  for (const violation of violations) {
    console.error(
      `- ${violation.path}: ${violation.rule} ${violation.base} -> ${violation.current}`,
    );
    for (const line of violation.lines) console.error(`    ${line}`);
  }
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
