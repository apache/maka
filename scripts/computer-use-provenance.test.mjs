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

  assert.ok(
    candidates.size >= 10,
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
  // cua-driver is a third-party binary that is redistributed, so §1 has to keep
  // pointing at a notice that travels with it.
  assert.ok(manifest.cuaDriver, 'the manifest still pins cua-driver');
  assert.match(document, /resources\/licenses\/cua-driver/);
  // maka-cu is Maka's own and unsigned, so §1 says so rather than listing it as
  // a redistributed component — and the manifest must agree that it does not
  // ship.
  assert.match(document, /maka-cu/);
  assert.equal(manifest.makaCu?.distributionReady, false);
});
