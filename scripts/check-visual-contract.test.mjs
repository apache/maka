import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { checkScopeCoverage, diffRecords, partitionChanges } from './check-visual-contract.mjs';

const record = (path, extra = {}) => ({ path, rect: [0, 0, 10, 10], ...extra });

test('declared scopes fail closed and cannot claim most of a capture', () => {
  const baseOnlyClaim = diffRecords(
    [record('body>div', { color: 'red', scope: 'legacy' })],
    [record('body>div', { color: 'blue' })],
  );
  assert.equal(partitionChanges(baseOnlyClaim, ['legacy']).outOfScope.length, 1);
  const claimed = (count, scope) =>
    Array.from({ length: count }, (_, index) => record(`p${index}-${scope}`, { scope }));
  assert.deepEqual(
    checkScopeCoverage([
      ...claimed(2, 'field'),
      ...claimed(2, 'switch'),
      ...claimed(2, 'selector'),
      ...claimed(4, undefined),
    ]),
    [{ scope: '<declared union>', claimed: 6, total: 10 }],
  );
});

test('repeatable scopes stay bounded per root and in total', () => {
  const scope = [{ name: 'item', repeatable: true }];
  const smallRoots = Array.from({ length: 10 }, (_, root) => [
    record(`p${root}`, { scope: 'item', scopeRoot: true }),
    record(`p${root}>span`, { scope: 'item' }),
  ]).flat();
  assert.deepEqual(
    checkScopeCoverage(
      [...smallRoots, ...Array.from({ length: 15 }, (_, index) => record(`outside${index}`))],
      undefined,
      scope,
    ),
    [],
  );

  const broadRoots = [0, 1].flatMap((root) => [
    record(`b${root}`, { scope: 'item', scopeRoot: true }),
    ...Array.from({ length: 44 }, (_, index) =>
      record(`b${root}>span:${index}`, { scope: 'item' }),
    ),
  ]);
  assert.deepEqual(
    checkScopeCoverage(
      [...broadRoots, ...Array.from({ length: 10 }, (_, index) => record(`outside${index}`))],
      undefined,
      scope,
    ),
    [{ scope: 'item', claimed: 90, total: 100 }],
  );

  const leafRoots = Array.from({ length: 60 }, (_, index) =>
    record(`leaf${index}`, { scope: 'item', scopeRoot: true }),
  );
  assert.deepEqual(
    checkScopeCoverage(
      [...leafRoots, ...Array.from({ length: 40 }, (_, index) => record(`outside${index}`))],
      undefined,
      scope,
    ),
    [{ scope: 'item', claimed: 60, total: 100 }],
  );
});
