import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const repoRoot = new URL('../', import.meta.url);

async function readRepoFile(path) {
  return readFile(new URL(path, repoRoot), 'utf8');
}

test('repository ships the canonical Apache License 2.0 grant', async () => {
  const license = await readRepoFile('LICENSE');

  assert.match(license, /^\s*Apache License\s+Version 2\.0, January 2004/m);
  assert.match(license, /http:\/\/www\.apache\.org\/licenses\//);
  assert.match(license, /2\. Grant of Copyright License\./);
  assert.match(license, /3\. Grant of Patent License\./);
  assert.match(license, /END OF TERMS AND CONDITIONS/);
});

test('root and workspace package metadata use the Apache-2.0 SPDX identifier', async () => {
  const rootPackage = JSON.parse(await readRepoFile('package.json'));
  assert.equal(rootPackage.license, 'Apache-2.0');

  for (const workspace of rootPackage.workspaces) {
    const manifest = JSON.parse(await readRepoFile(`${workspace}/package.json`));
    assert.equal(
      manifest.license,
      'Apache-2.0',
      `${workspace}/package.json must declare the repository license`,
    );
  }
});

test('public documentation links the license and attribution notice', async () => {
  const notice = await readRepoFile('NOTICE');
  assert.match(notice, /Copyright 2026 The Maka Authors/);

  for (const readme of ['README.md', 'README.zh-CN.md']) {
    const content = await readRepoFile(readme);
    assert.match(content, /\[.*Apache License 2\.0.*\]\(\.\/LICENSE\)/);
    assert.match(content, /\[NOTICE\]\(\.\/NOTICE\)/);
  }
});
