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
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';

import {
  analyzeTsx,
  assertNoAstryxBlockers,
  assertAstryxComponentSet,
  loadAstryxComponents,
  loadMakaUiBarrel,
  parseAstryxDistComponents,
} from './generate-astryx-surface-inventory.mjs';

const tmpRoots = [];
/** Materialize a fake repo root (`packages/ui/src/*`) from a {relPath: source} map. */
function fixtureRepo(files) {
  const repoRoot = mkdtempSync(join(tmpdir(), 'astryx-inv-'));
  tmpRoots.push(repoRoot);
  for (const [rel, contents] of Object.entries(files)) {
    const abs = join(repoRoot, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, contents);
  }
  return repoRoot;
}
after(() => {
  for (const dir of tmpRoots) rmSync(dir, { force: true, recursive: true });
});

describe('Astryx component set derivation (#3868)', () => {
  test('is derived from @astryxdesign/core with the resolved version', () => {
    const { version, components } = loadAstryxComponents();
    assert.match(version, /^\d+\.\d+\.\d+/);
    assert.ok(components instanceof Set);
    // Components the old 47-name hand-list omitted — the drift #3868 fixes.
    for (const name of ['Timestamp', 'ChatMessage', 'ChatMessageMetadata', 'Thumbnail']) {
      assert.ok(components.has(name), `expected derived set to include ${name}`);
    }
    // Fail-closed floor: a partial parse must not slip through.
    assert.ok(components.size >= 150, `expected >=150 components, got ${components.size}`);
    // Type/prop exports are not components.
    assert.ok(!components.has('ButtonProps'));
    assert.ok(!components.has('BaseProps'));
  });
});

describe('Astryx declaration parsing is fail-closed (#3868)', () => {
  test('traverses a genuine multi-level `export *` barrel graph', () => {
    // dist/index.d.ts --export*--> Group --export*--> Sub --export*--> Leaf,
    // where the component is only declared in the deepest file. A one-layer
    // parser would stop at Group and silently omit Deep; the recursive walk
    // (relative to each file's own dir) must reach it.
    const repoRoot = fixtureRepo({
      'dist/index.d.ts': ["export { Direct } from './Direct';", "export * from './Group';"].join(
        '\n',
      ),
      'dist/Group/index.d.ts': "export * from './Sub';\n",
      'dist/Group/Sub/index.d.ts': "export * from './Leaf';\n",
      'dist/Group/Sub/Leaf/index.d.ts': 'export declare const Deep: unknown;\n',
    });
    const set = parseAstryxDistComponents(join(repoRoot, 'dist'));
    assert.ok(set.has('Direct'), 'top-level named re-export resolves');
    assert.ok(set.has('Deep'), 'component behind a 3-level barrel graph resolves');
  });

  test('resolves a flat `Dir.d.ts` barrel target alongside directory barrels', () => {
    const repoRoot = fixtureRepo({
      'dist/index.d.ts': "export * from './Flat';\n",
      'dist/Flat.d.ts': 'export declare function FlatOne(): null;\n',
    });
    const set = parseAstryxDistComponents(join(repoRoot, 'dist'));
    assert.ok(set.has('FlatOne'));
  });

  test('is cycle-safe when barrels re-export each other', () => {
    // A ⇄ B mutual `export *` must terminate, not overflow the stack.
    const repoRoot = fixtureRepo({
      'dist/index.d.ts': "export * from './A';\n",
      'dist/A/index.d.ts': ["export * from '../B';", 'export declare const FromA: unknown;'].join(
        '\n',
      ),
      'dist/B/index.d.ts': ["export * from '../A';", 'export declare const FromB: unknown;'].join(
        '\n',
      ),
    });
    const set = parseAstryxDistComponents(join(repoRoot, 'dist'));
    assert.ok(set.has('FromA'));
    assert.ok(set.has('FromB'));
  });

  test('throws on an unresolved barrel target', () => {
    const repoRoot = fixtureRepo({ 'dist/index.d.ts': "export * from './Missing';\n" });
    assert.throws(() => parseAstryxDistComponents(join(repoRoot, 'dist')), /unresolved/i);
  });

  test('throws on an unresolved target nested below the first barrel layer', () => {
    const repoRoot = fixtureRepo({
      'dist/index.d.ts': "export * from './Group';\n",
      'dist/Group/index.d.ts': "export * from './Gone';\n",
    });
    assert.throws(() => parseAstryxDistComponents(join(repoRoot, 'dist')), /unresolved/i);
  });

  test('rejects a partial parse (too few components / missing a key component)', () => {
    assert.throws(() => assertAstryxComponentSet(new Set(['Button']), '0.5.0'), /incomplete/i);
    const bigButMissingKey = new Set(Array.from({ length: 200 }, (_, i) => `Widget${i}`));
    assert.throws(() => assertAstryxComponentSet(bigButMissingKey, '0.5.0'), /missing/i);
  });
});

describe('@maka/ui barrel resolution (#3868)', () => {
  test('derives the Astryx re-export map from the real barrel', () => {
    const { reexports } = loadMakaUiBarrel();
    // Auto-derived (replaces a hand-written 9-name list) — much broader coverage.
    assert.ok(reexports.size >= 20, `expected a broad re-export map, got ${reexports.size}`);
    // A direct re-export maps to its canonical Astryx name.
    assert.equal(reexports.get('Selector'), 'Selector');
    assert.equal(reexports.get('Button'), 'Button');
    assert.equal(reexports.get('CommandPalette'), 'CommandPalette');
  });

  test('resolves nested export graphs and flags only local public shadows', () => {
    const repoRoot = fixtureRepo({
      'packages/ui/src/index.ts': [
        "export { Button, Badge as UiBadge } from '@astryxdesign/core';",
        "export * from './local.js';",
        'export function Card() { return null; }', // local public shadow: Card is an Astryx component
        'export function MyWidget() { return null; }', // not an Astryx name → not a shadow
      ].join('\n'),
      'packages/ui/src/local.ts': [
        "export { Timestamp } from '@astryxdesign/core';",
        'export function helperThing() { return null; }',
      ].join('\n'),
    });
    const { reexports, shadowsByFile } = loadMakaUiBarrel(repoRoot);
    // Direct + aliased + transitive (through export *) re-exports all resolve.
    assert.equal(reexports.get('Button'), 'Button');
    assert.equal(reexports.get('UiBadge'), 'Badge');
    assert.equal(reexports.get('Timestamp'), 'Timestamp');
    // Only the locally-defined public export whose name shadows Astryx is flagged.
    assert.equal(shadowsByFile.get('packages/ui/src/index.ts')?.has('Card'), true);
    assert.equal(shadowsByFile.get('packages/ui/src/index.ts')?.has('MyWidget'), false);
  });

  test('fails closed on an unresolved relative barrel target', () => {
    const repoRoot = fixtureRepo({
      'packages/ui/src/index.ts': "export * from './does-not-exist.js';\n",
    });
    assert.throws(() => loadMakaUiBarrel(repoRoot), /unresolved/i);
  });
});

describe('analyzeTsx severity (#3868)', () => {
  const astryxComponents = loadAstryxComponents().components;
  const base = { astryxComponents, makaUiReexports: new Map(), shadowNames: null };

  test('counts a rendered Astryx component in the "Astryx used" column', () => {
    const src = `
      import { Timestamp } from '@astryxdesign/core';
      export function Row() { return <Timestamp value={0} />; }
    `;
    const result = analyzeTsx('packages/ui/src/row.tsx', src, base);
    assert.match(result.astryx, /Timestamp/);
    assert.equal(result.severity, 'aligned');
  });

  test('counts an Astryx component imported via the @maka/ui re-export map', () => {
    const src = `
      import { Selector } from '@maka/ui';
      export function Row() { return <Selector value="x" />; }
    `;
    const result = analyzeTsx('apps/desktop/src/renderer/row.tsx', src, {
      ...base,
      makaUiReexports: new Map([['Selector', 'Selector']]),
    });
    assert.match(result.astryx, /Selector/);
    assert.equal(result.severity, 'aligned');
  });

  test('flags a public export that shadows an Astryx component', () => {
    const src = 'export function Button() { return null; }\n';
    const result = analyzeTsx('packages/ui/src/button.tsx', src, {
      ...base,
      shadowNames: new Set(['Button']),
    });
    assert.equal(result.severity, 'reimplementation');
    assert.match(result.gaps, /public export `Button` shadows Astryx component/);
  });

  test('does not flag a private local component that merely shares a name', () => {
    // No shadowNames for this file (it is not a public @maka/ui export).
    const src = `
      export function ModuleHubSelector() {
        function Selector() { return null; }
        return <Selector />;
      }
    `;
    const result = analyzeTsx('packages/ui/src/module-hub-selector.tsx', src, base);
    assert.equal(result.severity, 'aligned');
    assert.doesNotMatch(result.gaps, /shadows/);
  });

  test('still flags a raw interactive control as a blocker', () => {
    const src = 'export function Bad() { return <button type="button">x</button>; }\n';
    const result = analyzeTsx('packages/ui/src/bad.tsx', src, base);
    assert.equal(result.severity, 'blocker');
  });

  test('blocks hand-written span and div actions with an actionable Astryx diagnostic', () => {
    for (const src of [
      'export function Bad() { return <span onClick={() => {}}>x</span>; }',
      'export function Bad() { return <div role="button" tabIndex={0}>x</div>; }',
    ]) {
      const result = analyzeTsx('packages/ui/src/bad.tsx', src, base);
      assert.equal(result.severity, 'aligned');
      assert.match(result.admissionGaps.join('; '), /use Astryx `Button`/);
      assert.match(result.admissionGaps.join('; '), /do not hand-write controls/);
    }
  });

  test('allows non-interactive spans and divs used for layout or text', () => {
    const src = 'export function Fine() { return <div><span>x</span></div>; }\n';
    const result = analyzeTsx('packages/ui/src/fine.tsx', src, base);
    assert.equal(result.severity, 'aligned');
    assert.deepEqual(result.admissionGaps, []);
  });

  test('fails the CI gate even after a blocker inventory is regenerated', () => {
    assert.throws(
      () =>
        assertNoAstryxBlockers({
          blockers: [
            {
              path: 'packages/ui/src/bad.tsx',
              gaps: 'hand-written interactive `<span>`; use Astryx `Button`; do not hand-write controls',
            },
          ],
        }),
      /Astryx surface blocker.*packages\/ui\/src\/bad\.tsx.*use Astryx `Button`.*do not hand-write controls/is,
    );
  });

  test('permits only exact legacy blocker fingerprints, never new debt at the same path', () => {
    const path = 'packages/ui/src/legacy.tsx';
    const gaps =
      'hand-written interactive `<div>` (1 occurrence); use Astryx `Button`; do not hand-write controls';
    const baseline = new Map([[path, gaps]]);
    assert.doesNotThrow(() => assertNoAstryxBlockers({ blockers: [{ path, gaps }] }, baseline));
    assert.throws(
      () =>
        assertNoAstryxBlockers(
          {
            blockers: [
              {
                path,
                gaps: 'hand-written interactive `<div>` (2 occurrences); use Astryx `Button`; do not hand-write controls',
              },
            ],
          },
          baseline,
        ),
      /Astryx surface blocker/,
    );
  });
});
