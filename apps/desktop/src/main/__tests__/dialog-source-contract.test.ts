/**
 * Static contract: renderer + ui tsx must not hand-write dialog semantics
 * (#520 PR7 commit 1).
 *
 * Astryx Dialog / AlertDialog set `role="dialog"` / `role="alertdialog"` /
 * `aria-modal="true"` themselves via native `<dialog>`. Hand-writing these
 * attributes in JSX bypasses Astryx's focus, restore, Escape, and top-layer
 * ownership.
 */
import { strict as assert } from 'node:assert';
import { readFile, readdir } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { join, relative, resolve, sep } from 'node:path';

const REPO_ROOT = resolve(process.cwd(), '..', '..');
const SCAN_ROOTS = [
  join(REPO_ROOT, 'apps', 'desktop', 'src'),
  join(REPO_ROOT, 'packages', 'ui', 'src'),
];

const FORBIDDEN_PATTERNS: Array<{ name: string; re: RegExp }> = [
  // role="dialog" / role = "dialog" (literal, tolerant of spaces around =)
  { name: 'role="dialog"', re: /role\s*=\s*["']dialog["']/ },
  { name: 'role="alertdialog"', re: /role\s*=\s*["']alertdialog["']/ },
  // role={'dialog'} / role={ "dialog" } / role={`dialog`} (expression string)
  { name: "role={'dialog'}", re: /role\s*=\s*\{\s*[`'"]dialog[`'"]\s*\}/ },
  { name: "role={'alertdialog'}", re: /role\s*=\s*\{\s*[`'"]alertdialog[`'"]\s*\}/ },
  // aria-modal="true" / aria-modal={'true'} / aria-modal={true} / aria-modal = { true }
  // (true may be quoted or a bare boolean; tolerant of spaces)
  { name: 'aria-modal="true"', re: /aria-modal\s*=\s*["']true["']/ },
  { name: 'aria-modal={true}', re: /aria-modal\s*=\s*\{\s*[`'"]?true[`'"]?\s*\}/ },
];

async function* walk(dir: string): AsyncIterableIterator<string> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '__tests__') continue;
      yield* walk(full);
    } else if (entry.isFile() && (entry.name.endsWith('.tsx') || entry.name.endsWith('.ts'))) {
      yield full;
    }
  }
}

// Strip line and block comment lines so doc references (e.g. search-modal.tsx
// top-of-file `* role="dialog" / aria-modal="true"` explaining the OLD
// contract) don't trip the literal scan. Only comment-only lines are dropped;
// trailing `// ...` on code lines is left intact, which is fine because a JSX
// attribute never shares a line with a trailing comment in this codebase.
function stripCommentLines(src: string): string {
  return src
    .split('\n')
    .map((line) => {
      const trimmed = line.trimStart();
      if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) {
        return '';
      }
      return line;
    })
    .join('\n');
}

describe('FORBIDDEN_PATTERNS coverage (#520 PR7)', () => {
  it('matches both literal and JSX-expression forms', () => {
    const positives = [
      'role="dialog"', "role='dialog'",
      'role="alertdialog"', "role='alertdialog'",
      'aria-modal="true"', "aria-modal='true'",
      "role={'dialog'}", 'role={"dialog"}', 'role={`dialog`}',
      "role={'alertdialog'}", 'role={"alertdialog"}',
      "aria-modal={'true'}", 'aria-modal={"true"}',
      // spaces around = and inside {}
      'role = "dialog"', "role = {'dialog'}",
      'aria-modal = { true }',
      // bare boolean (no quotes)
      'aria-modal={true}',
    ];
    for (const sample of positives) {
      assert.ok(
        FORBIDDEN_PATTERNS.some((p) => p.re.test(sample)),
        `expected FORBIDDEN_PATTERNS to match: ${sample}`,
      );
    }
    // benign samples must NOT match
    const negatives = [
      'role="region"',
      'aria-label="关闭"',
      "const dialogName = 'dialog'",
      'data-slot="dialog-popup"',
    ];
    for (const sample of negatives) {
      assert.ok(
        !FORBIDDEN_PATTERNS.some((p) => p.re.test(sample)),
        `expected FORBIDDEN_PATTERNS to NOT match: ${sample}`,
      );
    }
  });
});

describe('dialog source contract (#520 PR7)', () => {
  it('no production tsx/ts hand-writes role="dialog" / aria-modal', async () => {
    const offenders: Array<{ file: string; pattern: string }> = [];
    for (const root of SCAN_ROOTS) {
      for await (const file of walk(root)) {
        const rel = relative(REPO_ROOT, file).split(sep).join('/');
        if (file.endsWith('.test.ts') || file.endsWith('.test.tsx')) continue;
        const src = stripCommentLines(await readFile(file, 'utf8'));
        for (const pattern of FORBIDDEN_PATTERNS) {
          if (pattern.re.test(src)) {
            offenders.push({ file: rel, pattern: pattern.name });
          }
        }
      }
    }
    assert.deepEqual(
      offenders,
      [],
      'hand-writing role="dialog" / role="alertdialog" / aria-modal="true" bypasses Astryx Dialog focus/Esc handling — route through direct Astryx Dialog / AlertDialog.',
    );
  });
});
