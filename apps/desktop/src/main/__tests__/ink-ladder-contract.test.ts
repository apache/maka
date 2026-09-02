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
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * Prose has exactly two tiers, and the two retired ink names stay gone —
 * DESIGN.md §3, The Two-Tier Reading Rule.
 *
 * The name can come back in any of four shapes: a CSS declaration, a `var()`
 * reference, a TS theme-token key (makaTheme.ts), or an inline style in a
 * story. So the check is a bare-substring search over source text with
 * comments removed, not a CSS-declaration pattern — a comment may still name a
 * retired token to explain why it is retired.
 */
const testDir = dirname(fileURLToPath(import.meta.url));
// From either src/main/__tests__ or dist/main/__tests__ this lands on
// apps/desktop; the tests run from dist, so it must hold for both.
const DESKTOP_ROOT = resolve(testDir, '../../..');
const REPO_ROOT = resolve(DESKTOP_ROOT, '../..');

const TOKENS_PATH = join(DESKTOP_ROOT, 'src', 'renderer', 'maka-tokens.css');
const SOURCE_ROOTS = [
  join(DESKTOP_ROOT, 'src', 'renderer'),
  join(DESKTOP_ROOT, 'stories'),
  join(REPO_ROOT, 'packages', 'ui', 'src'),
  join(REPO_ROOT, 'packages', 'ui', 'stories'),
];
const SOURCE_EXTENSIONS = ['.css', '.ts', '.tsx'];

const RETIRED_INK = ['--foreground-secondary', '--foreground-dimmed'];

async function sourceFilesUnder(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const found: string[] = [];
  for (const entry of entries) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      found.push(...(await sourceFilesUnder(full)));
    } else if (SOURCE_EXTENSIONS.some((extension) => entry.name.endsWith(extension))) {
      found.push(full);
    }
  }
  return found;
}

function withoutComments(source: string): string {
  return source.replaceAll(/\/\*[\s\S]*?\*\//g, ' ').replaceAll(/\/\/.*$/gm, ' ');
}

describe('ink ladder', () => {
  it('keeps the retired ink names out of product source', async () => {
    const files = (await Promise.all(SOURCE_ROOTS.map(sourceFilesUnder))).flat();
    assert.ok(files.length > 0, 'found no source to check — the roots moved');

    const offenders: string[] = [];
    for (const file of files) {
      const source = withoutComments(await readFile(file, 'utf8'));
      for (const name of RETIRED_INK) {
        if (source.includes(name)) {
          offenders.push(`${relative(REPO_ROOT, file)} → ${name}`);
        }
      }
    }

    assert.deepEqual(
      offenders,
      [],
      'prose has two tiers: --foreground and --muted-foreground. A third grey is how dimmed and secondary drifted apart before',
    );
  });

  it('derives every ink tier in one colour space', async () => {
    const css = await readFile(TOKENS_PATH, 'utf8');
    // A tier mixed in srgb while its siblings mix in oklch is the same defect
    // in a different costume, and it is invisible in review because the
    // percentages match.
    const srgbInk = [
      ...css.matchAll(/^\s*(--[a-z-]*foreground[a-z-]*):\s*color-mix\(in srgb[^;]*;/gm),
    ];
    assert.deepEqual(
      srgbInk.map((match) => match[1]),
      [],
      'ink tiers derive in oklch; an srgb mix gives the same words a different colour',
    );
  });
});
