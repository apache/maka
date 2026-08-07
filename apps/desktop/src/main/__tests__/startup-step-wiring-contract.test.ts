/**
 * The wiring, not the component.
 *
 * `startup-step.test.ts` builds every `startupStep` call it checks, so it stays
 * green with the production boot calling nothing at all: the whole module can be orphaned
 * in the tree and the desktop main suite does not move. That is the shape of
 * the failure this pins — a later edit to the boot drops the wrappers, CI is
 * green, and the silent launch these lines exist to name comes back while the
 * diagnostic still looks healthy from the test report.
 *
 * The boot binds `ipcMain` and `app` at module scope and runs top-level await,
 * so it cannot be imported under `node --test`; there is no seam to observe the
 * calls through. Asserting against the source text is the precedent already in
 * this directory (`app-region-hygiene-contract.test.ts`), for the same reason:
 * the thing that must not silently change is not reachable from a test process.
 *
 * Each step is pinned twice — the wrapped form must be present, and the bare
 * `await` must be absent. The second half is what fails when a wrapper is
 * unwrapped rather than renamed.
 */
import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

const BOOT = resolve(import.meta.dirname, '../../../src/main/runtime-host-boot.ts');

/**
 * Drop whole-line `//` comments, so prose about a wrapper cannot stand in for
 * the wrapper. Trailing comments are left alone rather than risk cutting a
 * `https://` inside a string literal.
 */
function stripLineComments(source: string): string {
  return source
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n');
}

/** Steps whose await is long enough that a hang there looks like a crash. */
const WRAPPED_STEPS = [
  { name: 'storage root', call: 'resolveDesktopStorageRoot' },
] as const;

describe('startup step wiring', () => {
  it('imports the reporter into boot', async () => {
    const boot = stripLineComments(await readFile(BOOT, 'utf8'));
    assert.match(
      boot,
      /import\s*\{[^}]*\bstartupStep\b[^}]*\bwhileAwaitingPerson\b[^}]*\}\s*from\s*["']\.\/startup-step\.js["']/,
      'production boot must take both halves of the reporter',
    );
  });

  for (const { name, call } of WRAPPED_STEPS) {
    it(`names ${name} while awaiting it`, async () => {
      const boot = stripLineComments(await readFile(BOOT, 'utf8'));
      assert.match(
        boot,
        new RegExp(`await startupStep\\(\\s*["']${name}["'],\\s*${call}\\(`),
        `${call} must be awaited through startupStep('${name}'), or a hang there prints nothing`,
      );
      assert.doesNotMatch(
        boot,
        new RegExp(`await\\s+${call}\\(`),
        `${call} must not be awaited bare; that is the unwrapped form this file exists to catch`,
      );
    });
  }

  it('hands the repair dialog to the person rather than calling it a hang', async () => {
    const boot = stripLineComments(await readFile(BOOT, 'utf8'));
    assert.match(
      boot,
      /await whileAwaitingPerson\(\s*dialog\.showMessageBox\(/,
      'the repair modal must run inside whileAwaitingPerson, or reading it prints "still waiting" every three seconds',
    );
    assert.doesNotMatch(
      boot,
      /await\s+dialog\.showMessageBox\(/,
      'a bare await on the modal is the unwrapped form: it loses both the quiet and the one line naming a dialog that never opened',
    );
  });
});
