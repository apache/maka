// Unit tests for the pure parts of the migration contract harness.
//
// These exist because the harness shipped two bugs a table test would have
// caught at design time: three `INITIAL_VALUES` entries that never matched
// what Chromium serialises (so the properties they were meant to suppress
// appeared on every record), and a diff whose behaviour under a wrapper
// insertion nobody had measured.
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
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

describe('diffRecords', () => {
  it('names the changed properties with both values', () => {
    const before = [record('body>div', { color: 'red' })];
    const after = [record('body>div', { color: 'blue' })];
    const changes = diffRecords(before, after);
    assert.equal(changes.length, 1);
    assert.equal(changes[0].kind, 'changed');
    assert.deepEqual(changes[0].properties, [{ property: 'color', before: 'red', after: 'blue' }]);
  });

  it('reports a property that appeared as a diff from absent', () => {
    // The omission scheme reads "absent means the initial or inherited value",
    // so a migration that starts setting one has to show up.
    const changes = diffRecords([record('body>div')], [record('body>div', { boxShadow: '0 1px' })]);
    assert.deepEqual(changes[0].properties, [
      { property: 'boxShadow', before: undefined, after: '0 1px' },
    ]);
  });

  it('sorts real property changes ahead of the structural churn', () => {
    // A wrapper insertion renames paths, which reads as removed+added. Those
    // must not push a genuine `changed` past the print limit.
    const before = [record('body>div', { color: 'red' }), record('body>p')];
    const after = [record('body>div', { color: 'blue' }), record('body>section')];
    const kinds = diffRecords(before, after).map((change) => change.kind);
    assert.equal(kinds[0], 'changed');
    assert.deepEqual(kinds.slice(1).sort(), ['added', 'removed']);
  });

  it('re-keys the whole subtree when a wrapper is inserted', () => {
    // Documents the known limit rather than asserting it is fine: identity is
    // the path, so this is a `removed` plus an `added` per descendant. PR 1
    // does not touch the DOM, which is the slice this harness was built for.
    const before = [record('body>div'), record('body>div>span'), record('body>div>span>b')];
    const after = [
      record('body>div'),
      record('body>div>i'),
      record('body>div>i>span'),
      record('body>div>i>span>b'),
    ];
    const changes = diffRecords(before, after);
    assert.equal(changes.filter((c) => c.kind === 'removed').length, 2);
    assert.equal(changes.filter((c) => c.kind === 'added').length, 3);
  });
});

describe('summarise', () => {
  it('flags a diff whose shape means the tree moved, not the styles', () => {
    const changes = Array.from({ length: 60 }, (_, i) => ({
      kind: 'removed',
      path: `body>div>p:${i}`,
    }));
    const { structural, text } = summarise(changes, 100);
    assert.equal(structural, true);
    assert.match(text, /60 removed/);
  });

  it('does not flag a handful of removals in a large baseline', () => {
    const changes = [
      { kind: 'removed', path: 'body>div' },
      { kind: 'changed', path: 'body>p' },
    ];
    assert.equal(summarise(changes, 100).structural, false);
  });
});

describe('property tables', () => {
  // Which properties CSS itself inherits, among those worth capturing. This
  // is a spec fact, restated here so the tables cannot drift from it: the
  // harness shipped `textAlign` in PROPERTIES but not INHERITED_PROPERTIES,
  // and 79–85% of all records re-recorded an ancestor's value — one container
  // change printed as N descendant lines and ate the 40-line print limit.
  // `findDeadOmissionRules` cannot see this class (it only checks
  // INITIAL_VALUES keys), so it is pinned statically instead.
  const CSS_INHERITED = new Set([
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

  it('routes every CSS-inherited property through the inherited omission', () => {
    for (const property of PROPERTIES) {
      if (!CSS_INHERITED.has(property)) continue;
      assert.ok(
        INHERITED_PROPERTIES.includes(property),
        `${property} is CSS-inherited but absent from INHERITED_PROPERTIES: every descendant will re-record its ancestor's value`,
      );
    }
  });

  it('never routes a non-inherited property through the inherited omission', () => {
    // The reverse direction: a non-inherited property in INHERITED_PROPERTIES
    // would be omitted whenever it happens to equal an ancestor's value —
    // an omission the reader would wrongly "recover" as inheritance.
    for (const property of INHERITED_PROPERTIES) {
      assert.ok(
        CSS_INHERITED.has(property),
        `${property} is in INHERITED_PROPERTIES but CSS does not inherit it`,
      );
    }
  });

  it('never gives an inherited property an initial-value rule too', () => {
    // "Absent" must mean exactly one thing. If an inherited property also had
    // an INITIAL_VALUES entry, a record could omit it for either reason, and
    // a reader recovering the value from the nearest recorded ancestor would
    // recover the wrong one.
    for (const property of INHERITED_PROPERTIES) {
      assert.ok(
        !(property in INITIAL_VALUES),
        `${property} is in both INHERITED_PROPERTIES and INITIAL_VALUES`,
      );
    }
  });
});

describe('findDeadOmissionRules', () => {
  it('flags a rule that never matched a single raw sample', () => {
    // The real bug: `gap: 'normal normal'` in the table, `normal` from
    // Chromium, so the rule matched zero samples and every record kept a
    // constant nobody could read as signal.
    const dead = findDeadOmissionRules(
      { sampled: 120, hits: { gap: 0 } },
      { gap: 'normal normal' },
    );
    assert.deepEqual(dead, [{ property: 'gap', sampled: 120 }]);
  });
});

describe('checkSalvagedAnchors', () => {
  const anchors = [{ commit: 'abc', regression: 'r', route: 'chat', anchor: 'list-row' }];
  const captureKey = 'chat.light.darwin';

  it('rejects a different hook that merely contains the anchor', () => {
    // `list-row-meta` is a different element; a substring match would report
    // the anchor as watched by something that is not the element the
    // regression happened on.
    const captures = new Map([[captureKey, [record('a', { contract: 'list-row-meta' })]]]);
    assert.equal(checkSalvagedAnchors(captures, anchors).length, 1);
  });

  it('does not accept a product class in place of the hook', () => {
    // Anchors moved off product classes on purpose: the class dies with the
    // slice that migrates the component, the hook survives it.
    const captures = new Map([[captureKey, [record('a', { classes: 'maka-list-row' })]]]);
    assert.equal(checkSalvagedAnchors(captures, anchors).length, 1);
  });

  it('skips routes that were not captured this run', () => {
    assert.deepEqual(checkSalvagedAnchors(new Map(), anchors), []);
  });
});

describe('declared scopes', () => {
  it('never reports harness bookkeeping as a visual diff', () => {
    // PR 2 adds the hooks while `main` has none: if `contract` or `scope`
    // were compared, the hook rollout itself would break the zero-diff gate.
    const before = [record('body>div'), record('body>div>span')];
    const after = [
      record('body>div', { contract: 'session-workbar', scope: 'workbar' }),
      record('body>div>span', { scope: 'workbar' }),
    ];
    assert.deepEqual(diffRecords(before, after), []);
  });

  it('attributes a changed element to the scope that landed it', () => {
    const before = [record('body>div', { color: 'red', scope: 'legacy-button' })];
    const after = [record('body>div', { color: 'blue', scope: 'button' })];
    const changes = diffRecords(before, after);
    assert.equal(changes[0].scope, 'button');
  });

  it('fails closed when only the base side claimed a changed element', () => {
    // A mistyped migrated selector leaves the current side unclaimed. The
    // base side's legacy claim must NOT carry over, or every change inside
    // the old subtree would be silently waived (external review finding).
    const before = [record('body>div', { color: 'red', scope: 'legacy-button' })];
    const after = [record('body>div', { color: 'blue' })];
    const { outOfScope } = partitionChanges(diffRecords(before, after), ['legacy-button']);
    assert.equal(outOfScope.length, 1);
  });

  it('keeps the base attribution for a removed element', () => {
    // The migrated side no longer has the element, so only the base capture
    // knows which scope claimed it — the legacy selector the slice declared.
    const changes = diffRecords([record('body>div', { scope: 'button' })], []);
    assert.equal(changes[0].kind, 'removed');
    assert.equal(changes[0].scope, 'button');
  });

  it('splits declared changes from undeclared ones', () => {
    const changes = [
      { kind: 'changed', path: 'a', scope: 'button' },
      { kind: 'added', path: 'b', scope: 'badge' },
      { kind: 'changed', path: 'c' },
    ];
    const { inScope, outOfScope } = partitionChanges(changes, ['button']);
    assert.deepEqual(
      inScope.map((change) => change.path),
      ['a'],
    );
    assert.deepEqual(
      outOfScope.map((change) => change.path),
      ['b', 'c'],
    );
  });

  it('treats an empty declaration as the zero-diff gate', () => {
    const changes = [{ kind: 'changed', path: 'a', scope: 'button' }];
    const { inScope, outOfScope } = partitionChanges(changes, []);
    assert.equal(inScope.length, 0);
    assert.equal(outOfScope.length, 1);
  });
});

describe('checkScopeCoverage', () => {
  const claimed = (n, scope) => Array.from({ length: n }, (_, i) => record(`p${i}`, { scope }));

  it('fails a scope that claims most of a capture', () => {
    // `#root *` avoids the in-browser root floor (it matches no root element)
    // but still declares essentially the whole UI (external review finding).
    const records = [...claimed(6, 'frame'), ...claimed(4, undefined)];
    assert.deepEqual(checkScopeCoverage(records), [{ scope: 'frame', claimed: 6, total: 10 }]);
  });

  it('fails several individually small scopes whose union claims most of a capture', () => {
    const records = [
      ...claimed(2, 'field'),
      ...claimed(2, 'switch'),
      ...claimed(2, 'selector'),
      ...claimed(4, undefined),
    ];
    assert.deepEqual(checkScopeCoverage(records), [
      { scope: '<declared union>', claimed: 6, total: 10 },
    ]);
  });
});
