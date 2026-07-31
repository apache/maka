/**
 * PR-UI-DEAD-EXPORT-SWEEP-0 — lock the rule "every named export in
 * `packages/ui/src/ui.tsx` must have at least one consumer outside
 * ui.tsx itself".
 *
 * Without this gate, `ui.tsx` slowly accumulates Base UI primitive
 * re-exports + cva wrappers that nothing actually imports. They look
 * cheap (`export const X = Base.Y`) but add real cost: every export
 * shows up in autocomplete, in the bundle, in tsc work, and in design
 * audits as "an option we offer". When ~30 of them are dead and ~50
 * are alive, design discussions get poisoned by phantom variants.
 *
 * Allowlist:
 *   - `ui.tsx` itself (internal references are allowed)
 *   - `components.tsx` (legacy mega-module; gradually being unwound
 *     by PR-UI-LIB-EXTRACT-N; counts as a consumer for this gate)
 *
 * If a new export is introduced with no immediate consumer, the
 * caller has two options:
 *   1. Wire the consumer in the same PR (preferred)
 *   2. Add the symbol to ALLOWED_PENDING below with a justification
 *      and a target removal date (so it doesn't linger forever)
 */

import { strict as assert } from 'node:assert';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

const REPO_ROOT = resolve(import.meta.dirname, '../../../../..');
const UI_FILE = resolve(REPO_ROOT, 'packages/ui/src/ui.tsx');
const SOURCE_ROOTS = [
  resolve(REPO_ROOT, 'apps', 'desktop', 'src'),
  resolve(REPO_ROOT, 'packages', 'ui', 'src'),
  resolve(REPO_ROOT, 'packages', 'core', 'src'),
  resolve(REPO_ROOT, 'packages', 'runtime', 'src'),
  resolve(REPO_ROOT, 'packages', 'headless', 'src'),
  resolve(REPO_ROOT, 'packages', 'storage', 'src'),
];
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx']);

/**
 * Symbols that are exported but currently lack an external consumer.
 * Empty by design: PR-UI-DEAD-EXPORT-SWEEP-0 cleared the slate. Any
 * future entry needs a one-line justification + target removal date.
 */
const ALLOWED_PENDING: ReadonlyArray<{ name: string; reason: string }> = [
  // intentionally empty
];

// Compatibility exports are removed with their final consumers.
const FROZEN_COMPATIBILITY = new Set<string>();

async function readSourceFiles(dir: string): Promise<{ path: string; content: string }[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = resolve(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === '__tests__' || entry.name === 'node_modules' || entry.name === 'dist') return [];
        return readSourceFiles(entryPath);
      }
      const ext = entryPath.slice(entryPath.lastIndexOf('.'));
      if (!SOURCE_EXTENSIONS.has(ext)) return [];
      const content = await readFile(entryPath, 'utf8');
      return [{ path: entryPath, content }];
    }),
  );
  return files.flat();
}

function extractNamedExports(src: string): string[] {
  // Match: `export const Foo`, `export function Foo`, `export interface Foo`,
  // `export type Foo`, `export class Foo`.
  const names = new Set<string>();
  for (const m of src.matchAll(/^export (?:const|function|interface|type|class) ([A-Za-z][A-Za-z0-9_]*)/gm)) {
    names.add(m[1]!);
  }
  // Match: `export { Foo } from './path.js'` — only `cn` re-export today,
  // but include for completeness.
  for (const m of src.matchAll(/^export \{ ([^}]+) \}/gm)) {
    for (const part of m[1]!.split(',')) {
      const name = part.trim().split(/\s+as\s+/)[0]?.trim();
      if (name && /^[A-Za-z]/.test(name)) names.add(name);
    }
  }
  return [...names];
}

describe('PR-UI-DEAD-EXPORT-SWEEP-0 ui.tsx dead-export contract', () => {
  it('every named export in ui.tsx has at least one consumer outside ui.tsx', async () => {
    const [uiSrc, allSources] = await Promise.all([
      readFile(UI_FILE, 'utf8'),
      Promise.all(SOURCE_ROOTS.map((root) => readSourceFiles(root))).then((groups) => groups.flat()),
    ]);
    const exports = extractNamedExports(uiSrc);
    assert.ok(exports.length > 0, 'ui.tsx must continue to export symbols (sanity check)');

    const pending = new Set(ALLOWED_PENDING.map((entry) => entry.name));
    const dead: string[] = [];
    for (const name of exports) {
      if (pending.has(name)) continue;
      const re = new RegExp(`\\b${name}\\b`);
      const hasConsumer = allSources.some((file) => {
        if (file.path === UI_FILE) return false;
        return re.test(file.content);
      });
      if (!hasConsumer) dead.push(name);
    }

    assert.deepEqual(
      dead,
      [],
      `ui.tsx exports without any consumer outside ui.tsx (delete the export, wire a consumer, or add to ALLOWED_PENDING with a target removal date): ${dead.join(', ')}`,
    );
  });

  it('ALLOWED_PENDING does not accumulate stale entries', () => {
    // The expectation here is that ALLOWED_PENDING stays empty by
    // default. If it grows past a small handful, that's a signal the
    // codebase has started reintroducing dead exports — at which point
    // the cap forces a cleanup PR rather than letting the list rot.
    assert.ok(
      ALLOWED_PENDING.length <= 5,
      `ALLOWED_PENDING has ${ALLOWED_PENDING.length} entries (cap 5). Either ship the consumers or delete the exports.`,
    );
  });
});
