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
const THEME_SOURCE_PATH = join(DESKTOP_ROOT, 'src', 'renderer', 'astryx-theme', 'makaTheme.ts');
const THEME_CSS_PATH = join(DESKTOP_ROOT, 'src', 'renderer', 'astryx-theme', 'maka.css');
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

/** Every `--token: value;` in a stylesheet, whatever selector it sits under. */
function declarations(css: string): Map<string, string[]> {
  const byName = new Map<string, string[]>();
  for (const [, name, value] of css.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;{}]*);/g)) {
    byName.set(name, [...(byName.get(name) ?? []), value]);
  }
  return byName;
}

function referencedTokens(value: string): string[] {
  return [...value.matchAll(/var\(\s*(--[a-z0-9-]+)/g)].map((match) => match[1]);
}

/**
 * The product tokens `makaTheme.ts` hands to Astryx, plus everything those
 * values read, transitively. This is the set the media rule below binds — and
 * it is derived from the theme rather than listed here, so a new alias is
 * covered the moment it is written.
 */
function aliasedTokenClosure(themeSource: string, tokens: Map<string, string[]>): Set<string> {
  const queue = [...withoutComments(themeSource).matchAll(/'(?:--[a-z0-9-]+)':\s*'([^']*)'/g)]
    .flatMap((match) => referencedTokens(match[1]));
  const closure = new Set<string>();
  while (queue.length > 0) {
    const name = queue.pop() as string;
    if (closure.has(name)) continue;
    closure.add(name);
    for (const value of tokens.get(name) ?? []) queue.push(...referencedTokens(value));
  }
  return closure;
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

describe('mode expression', () => {
  it('keeps every token the Astryx theme aliases out of the .dark selector', async () => {
    // DESIGN.md §8, The Mode Lives in the Value Rule. Astryx inverts a surface
    // with `color-scheme: dark`, which a selector matched on <html> cannot
    // follow — so a colour parked under `.dark` keeps the page's mode on a
    // toast body or an overlay scrim. The error toast painted light-mode grey
    // on its red plate at 1.04:1 for exactly this reason.
    const css = await readFile(TOKENS_PATH, 'utf8');
    const themeSource = await readFile(THEME_SOURCE_PATH, 'utf8');
    const closure = aliasedTokenClosure(themeSource, declarations(withoutComments(css)));
    assert.ok(closure.size > 0, 'read no aliases out of makaTheme.ts — the token map moved');

    const offenders: string[] = [];
    for (const [, selector, body] of withoutComments(css).matchAll(
      /(?:^|\})\s*([^{}]*\.dark[^{}]*)\{([^{}]*)\}/g,
    )) {
      for (const name of declarations(body).keys()) {
        if (closure.has(name)) offenders.push(`${selector.trim()} → ${name}`);
      }
    }

    assert.deepEqual(
      offenders,
      [],
      'a colour that differs by mode carries both sides as light-dark(light, dark); only alphas and shadow recipes stay on .dark',
    );
  });

  it('collapses the ink tiers on an inverted surface', async () => {
    // DESIGN.md §3, the Tinted Surface Rule at full tint: a solid inverted
    // surface takes one ink tier. Astryx's own on-media defaults move primary
    // alone, so dropping the makaTheme onDark/onLight blocks would silently put
    // the muted rung back at 2.99:1 on the error toast.
    const themeCss = await readFile(THEME_CSS_PATH, 'utf8');
    const missing: string[] = [];
    for (const surface of ['dark', 'light']) {
      const block = themeCss.match(
        new RegExp(String.raw`\[data-astryx-media="${surface}"\]\s*\{([^}]*)\}`),
      );
      assert.ok(block, `maka.css has no on-${surface} block — regenerate with npm run astryx:theme`);
      for (const token of ['--color-text-secondary', '--color-icon-secondary']) {
        if (!block[1].includes(`${token}: var(--color-on-${surface})`)) {
          missing.push(`on-${surface} → ${token}`);
        }
      }
    }

    assert.deepEqual(
      missing,
      [],
      'an inverted surface has one ink tier: secondary takes the same on-color as primary',
    );
  });

  it('never reads a palette token as a colour', async () => {
    // A token's declared value stopped being a colour when the mode moved into
    // it: `light-dark()` resolves at the use site, so the declaration is a
    // recipe. Handing one to something that wants a colour fails silently —
    // `CSS.supports('color', …)` says yes and a canvas fillStyle ignores the
    // assignment, which is how the Windows titlebar sampled opaque black.
    // Read `getComputedStyle(element)` off whatever paints the token instead.
    const files = (await Promise.all(SOURCE_ROOTS.map(sourceFilesUnder))).flat();
    const offenders: string[] = [];
    for (const file of files) {
      if (!file.endsWith('.ts') && !file.endsWith('.tsx')) continue;
      const source = withoutComments(await readFile(file, 'utf8'));
      for (const match of source.matchAll(/getPropertyValue\(\s*['"`](--[a-z0-9-]+)/g)) {
        offenders.push(`${relative(REPO_ROOT, file)} → ${match[1]}`);
      }
    }

    assert.deepEqual(
      offenders,
      [],
      'a custom property reads back as its declaration, not as a resolved value',
    );
  });
});
