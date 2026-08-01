import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  checkSalvagedAnchors,
  checkScopeCoverage,
  diffRecords,
  findDeadOmissionRules,
  INHERITED_PROPERTIES,
  INITIAL_VALUES,
  partitionChanges,
  PROPERTIES,
  summarise,
} from './check-visual-contract.mjs';

const record = (path, extra = {}) => ({ path, rect: [0, 0, 10, 10], ...extra });

test('visual diffs preserve property values, scope, and structural priority', () => {
  const changes = diffRecords(
    [record('body>div', { color: 'red', scope: 'legacy' }), record('body>p')],
    [record('body>div', { color: 'blue', scope: 'current' }), record('body>section')],
  );

  assert.equal(changes[0].kind, 'changed');
  assert.equal(changes[0].scope, 'current');
  assert.deepEqual(changes[0].properties, [{ property: 'color', before: 'red', after: 'blue' }]);
  assert.deepEqual(
    diffRecords([record('a')], [record('a', { boxShadow: '0 1px' })])[0].properties,
    [{ property: 'boxShadow', before: undefined, after: '0 1px' }],
  );
  assert.deepEqual(
    changes
      .slice(1)
      .map(({ kind }) => kind)
      .sort(),
    ['added', 'removed'],
  );
  assert.equal(summarise(Array(60).fill({ kind: 'removed' }), 100).structural, true);
});

test('omission tables encode CSS inheritance without ambiguous or dead rules', () => {
  const cssInherited = new Set([
    'color',
    'cursor',
    'fontFamily',
    'fontSize',
    'fontStyle',
    'fontWeight',
    'letterSpacing',
    'lineHeight',
    'pointerEvents',
    'textAlign',
    'textTransform',
    'visibility',
    'whiteSpace',
    'wordBreak',
  ]);

  assert.deepEqual(
    PROPERTIES.filter((property) => cssInherited.has(property)).sort(),
    [...INHERITED_PROPERTIES].sort(),
  );
  assert.equal(
    INHERITED_PROPERTIES.some((property) => property in INITIAL_VALUES),
    false,
  );
  assert.deepEqual(findDeadOmissionRules({ sampled: 10, hits: { gap: 0 } }, { gap: 'normal' }), [
    { property: 'gap', sampled: 10 },
  ]);
});

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

test('salvaged anchors require an exact current capture hook', () => {
  const anchors = [{ commit: 'abc', regression: 'r', route: 'chat', anchor: 'list-row' }];
  const captures = new Map([['chat.light.darwin', [record('a', { contract: 'list-row-meta' })]]]);
  assert.equal(checkSalvagedAnchors(captures, anchors).length, 1);
  assert.deepEqual(checkSalvagedAnchors(new Map(), anchors), []);
});
