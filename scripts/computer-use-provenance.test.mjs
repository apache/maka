import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

/**
 * Rot guard for docs/computer-use-provenance.md.
 *
 * A provenance record that names files which have since moved is worse than no
 * record: it reads as authoritative and sends the next person to the wrong
 * place. Every repository path the document points at has to exist, and the
 * three sections it is built around have to still be there.
 */
const repoRoot = new URL('..', import.meta.url);
const document = await readFile(new URL('docs/computer-use-provenance.md', repoRoot), 'utf8');

test('every repository path the provenance record names still exists', async () => {
  // Backticked spans that look like repository paths: a slash, and a file
  // extension or a trailing slash for a directory.
  const candidates = new Set(
    [...document.matchAll(/`([A-Za-z0-9_./@-]+\/[A-Za-z0-9_./@-]*)`/g)]
      .map((match) => match[1])
      .filter((path) => /\.[a-z]+$/.test(path) || path.endsWith('/'))
      // Upstream references, not paths in this tree. They are written with
      // their repository name in front precisely so this stays decidable.
      .filter(
        (path) =>
          !path.startsWith('trycua/') &&
          !path.startsWith('open-codex-computer-use/') &&
          !path.startsWith('open-computer-use/') &&
          !path.includes('#'),
      ),
  );

  // A floor, not a count. It exists so that a regex that silently stops
  // matching cannot make this test vacuously pass; it moved from 10 to 8 when
  // cua-driver's two paths left the record with the executor itself.
  assert.ok(
    candidates.size >= 8,
    `expected the record to name real paths, found ${candidates.size}`,
  );

  const missing = [];
  for (const path of candidates) {
    try {
      await access(new URL(path, repoRoot));
    } catch {
      missing.push(path);
    }
  }
  assert.deepEqual(missing, [], `provenance record points at paths that do not exist: ${missing}`);
});

test('the record keeps redistribution, reference, and observation separate', () => {
  // The three cases carry different obligations. Collapsing them is how a
  // reverse-engineered behaviour ends up described as if it were licensed.
  assert.match(document, /^## 1\. Redistributed under license$/m);
  assert.match(document, /^## 2\. Licensed source read as reference$/m);
  assert.match(document, /^## 3\. Observed, not licensed$/m);
  assert.match(document, /confers no rights and is not a license/);
});

test('the record accounts for every executor the manifest pins', async () => {
  const manifest = JSON.parse(
    await readFile(new URL('apps/desktop/bundled-tools.json', repoRoot), 'utf8'),
  );
  // One executor, and it is Maka's own. The assertion is written as "no other
  // key" rather than "makaCu exists" because the thing worth catching is a
  // second executor being pinned without §1 gaining a row for it — which is
  // exactly how a third-party binary starts shipping unnoticed.
  assert.deepEqual(Object.keys(manifest), ['makaCu']);
  assert.match(document, /maka-cu/);
  // Unsigned, so it does not ship, so §1 has no redistributed executor to
  // carry a notice for.
  assert.equal(manifest.makaCu?.distributionReady, false);
  assert.doesNotMatch(document, /resources\/licenses\/cua-driver/);
});
