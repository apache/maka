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
const cursorSource = await readFile(
  new URL('apps/desktop/src/renderer/computer-use-overlay/engine/cursor-engine.ts', repoRoot),
  'utf8',
);
const cursorDocument = await readFile(
  new URL('docs/computer-use-cursor-provenance.md', repoRoot),
  'utf8',
);
const repositoryLicense = await readFile(new URL('LICENSE', repoRoot), 'utf8');

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

test('the record keeps redistribution, licensed source, and proprietary inspection separate', () => {
  // The three cases carry different obligations. Collapsing them is how a
  // binary-derived fact ends up described as if it were licensed source.
  assert.match(document, /MIT-licensed `trycua\/cua`/);
  assert.match(document, /`iFurySt\/open-codex-computer-use`/);
  assert.match(document, /comparison with Codex Desktop's implementation/);
  assert.match(document, /Maka integrated and adjusted those inputs through its own testing/);
  assert.match(document, /^## 1\. Redistributed under license$/m);
  assert.match(document, /^## 2\. Licensed source adapted or read as reference$/m);
  assert.match(document, /^## 3\. Proprietary implementation inspected for compatibility$/m);
  assert.match(document, /8c921b2b3bf13494724ead4f0a814d80c56a7e8b/);
  assert.match(document, /no\s+OpenAI source code or executable is included or redistributed/i);
  assert.match(document, /provides evidence, not a license grant/i);
});

test('the cursor provenance record preserves the mixed source boundary', () => {
  assert.match(cursorSource, /MIT-licensed/);
  assert.match(cursorSource, /trycua\/cua cursor-overlay/);
  assert.match(cursorSource, /0x1000972ec/);
  assert.match(cursorSource, /not term-for-term/i);
  assert.match(cursorSource, /additional score terms/);
  assert.match(cursorSource, /backwards-arrival/);
  assert.match(cursorDocument, /44320516c4c400fb5459b203498c78e4af318b0096464f16c4445a47f2b8b8f4/);
  assert.match(cursorDocument, /compatibility\s+reference and as a static-analysis input/);
  assert.match(cursorDocument, /Mach-O data\s+constants/);
  assert.match(cursorDocument, /Swift type and field metadata/);
  assert.match(cursorDocument, /disassembled control flow/);
  assert.match(cursorDocument, /^### Binary-derived facts still retained$/m);
  assert.match(cursorDocument, /^### Maka-authored or Maka-adjusted behavior$/m);
});

test('the repository license accounts for the trycua/cua MIT adaptation', () => {
  assert.match(repositoryLicense, /^trycua\/cua cursor-overlay$/m);
  assert.match(repositoryLicense, /Revision: 8c921b2b3bf13494724ead4f0a814d80c56a7e8b/);
  assert.match(repositoryLicense, /Copyright \(c\) 2025 Cua AI, Inc\./);
  assert.match(repositoryLicense, /Maka's agent-cursor renderer and palette include adaptations/);
  assert.match(repositoryLicense, /^MIT License$/m);
});

test('the cursor record preserves the artifact and applicable-terms review gates', () => {
  assert.match(cursorDocument, /^### Reproducibility limit$/m);
  assert.match(cursorDocument, /historical artifact is no longer present/);
  assert.match(cursorDocument, /d51dc8dd4c5a1ff19c13e206a8e5022db8bf5cb1c7aff0d67d6c7f4bb55dc031/);
  assert.match(cursorDocument, /cannot be independently reproduced from the repository alone/);
  assert.match(cursorDocument, /^### Applicable-terms gate before code transfer$/m);
  assert.match(cursorDocument, /independently replace those retained components/);
  assert.match(cursorDocument, /human legal or ASF determination/);
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
