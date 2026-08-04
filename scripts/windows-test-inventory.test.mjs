import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  collectWindowsTestSkips,
  findSkipExpressions,
  renderWindowsTestInventory,
  windowsTestInventoriesMatch,
} from './windows-test-inventory.mjs';

test('compares generated inventories independently of checkout line endings', () => {
  const rendered = '# Windows test skip inventory\n\nEntry\n';

  assert.equal(windowsTestInventoriesMatch(rendered.replaceAll('\n', '\r\n'), rendered), true);
  assert.equal(windowsTestInventoriesMatch(rendered.replaceAll('\n', '\r'), rendered), true);
  assert.equal(windowsTestInventoriesMatch(`${rendered}Changed\n`, rendered), false);
});

test('reads multiline skip expressions through their property delimiter', () => {
  const source = `
// skip: process.platform === 'win32',
const example = "skip: process.platform === 'win32',";
test('direct multiline', {
  skip:
    process.platform === 'win32'
      ? 'not on Windows'
      : false,
}, () => {});
test('logical multiline', {
  skip:
    process.platform === 'win32' ||
    anotherCondition,
  timeout: 1000,
}, () => {});
`;

  assert.deepEqual(
    findSkipExpressions(source).map(({ expression }) => expression),
    [
      "process.platform === 'win32'\n      ? 'not on Windows'\n      : false",
      "process.platform === 'win32' ||\n    anotherCondition",
    ],
  );
});

test('collects and classifies every test declaration that excludes Windows', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-windows-inventory-'));
  try {
    await mkdir(join(root, 'packages', 'runtime-host'), { recursive: true });
    await mkdir(join(root, 'apps', 'desktop'), { recursive: true });
    await writeFile(
      join(root, 'packages', 'runtime-host', 'host.test.ts'),
      `test('named pipe peer', {
  skip:
    process.platform === 'win32'
      ? 'not on Windows'
      : false,
}, () => {});
test('named pipe reconnect', {
  skip:
    process.platform === 'win32' ||
    anotherCondition,
}, () => {});
`,
    );
    await writeFile(
      join(root, 'apps', 'desktop', 'window.test.mjs'),
      'test(\'macOS window probe\', { skip: process.platform !== "darwin" }, () => {});\n',
    );

    const entries = await collectWindowsTestSkips(root);
    assert.deepEqual(
      entries.map(({ path, title, classification }) => ({ path, title, classification })),
      [
        {
          path: 'apps/desktop/window.test.mjs',
          title: 'macOS window probe',
          classification: 'platform-contract',
        },
        {
          path: 'packages/runtime-host/host.test.ts',
          title: 'named pipe peer',
          classification: 'windows-backend-gap',
        },
        {
          path: 'packages/runtime-host/host.test.ts',
          title: 'named pipe reconnect',
          classification: 'windows-backend-gap',
        },
      ],
    );
    const rendered = renderWindowsTestInventory(entries);
    assert.match(rendered, /Total Windows-excluded declarations: \*\*3\*\*/u);
    assert.match(rendered, /windows-backend-gap \| 2/u);
    assert.doesNotMatch(rendered, /window\.test\.mjs:\d+/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
