import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  findEnclosingTurnId,
  normalizeQuoteText,
  resolveQuoteTarget,
  type QuoteScopeNode,
} from '../selection-quote-target.js';

/**
 * Builds a parent → child chain and returns its nodes, outermost first, so a
 * test can hand any depth to the walker. `turnId` marks a node as a turn root.
 */
function chain(...levels: ReadonlyArray<{ turnId?: string }>): QuoteScopeNode[] {
  const nodes: QuoteScopeNode[] = [];
  let parent: QuoteScopeNode | null = null;
  for (const level of levels) {
    const node: QuoteScopeNode = {
      parentNode: parent,
      ...(level.turnId ? { dataset: { turnId: level.turnId } } : {}),
    };
    nodes.push(node);
    parent = node;
  }
  return nodes;
}

describe('normalizeQuoteText', () => {
  it('collapses the whitespace a selection picks up across elements', () => {
    assert.equal(normalizeQuoteText('  the  runtime\n  assembles \t tools '), 'the runtime assembles tools');
  });

  it('rejects a selection that holds nothing but whitespace', () => {
    assert.equal(normalizeQuoteText('   \n\t '), null);
    assert.equal(normalizeQuoteText(''), null);
  });
});

describe('findEnclosingTurnId', () => {
  it('returns the nearest turn id on the way up', () => {
    const [root, outerTurn, innerTurn, leaf] = chain(
      {},
      { turnId: 'turn-outer' },
      { turnId: 'turn-inner' },
      {},
    );
    assert.ok(root && leaf && outerTurn && innerTurn);
    assert.equal(findEnclosingTurnId(leaf, root), 'turn-inner');
  });

  it('rejects a node that never meets the root — the composer case', () => {
    const [, , composerLeaf] = chain({}, { turnId: 'turn-1' }, {});
    const [detachedRoot] = chain({});
    assert.ok(composerLeaf && detachedRoot);
    // The leaf sits under a turn, but under a *different* tree than the
    // transcript root, so it is out of scope even though a turn id is above it.
    assert.equal(findEnclosingTurnId(composerLeaf, detachedRoot), null);
  });

  it('rejects transcript text that belongs to no turn', () => {
    const [root, , leaf] = chain({}, {}, {});
    assert.ok(root && leaf);
    assert.equal(findEnclosingTurnId(leaf, root), null);
  });

  it('stops at the root rather than adopting a turn id above it', () => {
    const [ancestorTurn, root, leaf] = chain({ turnId: 'turn-above-root' }, {}, {});
    assert.ok(ancestorTurn && root && leaf);
    assert.equal(findEnclosingTurnId(leaf, root), null);
  });

  it('treats the root itself as out of scope', () => {
    const [root] = chain({});
    assert.ok(root);
    assert.equal(findEnclosingTurnId(root, root), null);
  });

  it('handles a null container', () => {
    const [root] = chain({});
    assert.ok(root);
    assert.equal(findEnclosingTurnId(null, root), null);
  });
});

describe('resolveQuoteTarget', () => {
  it('resolves text plus the owning turn', () => {
    const [root, , leaf] = chain({}, { turnId: 'turn-7' }, {});
    assert.ok(root && leaf);
    assert.deepEqual(resolveQuoteTarget('  assembles  tools ', leaf, root), {
      text: 'assembles tools',
      turnId: 'turn-7',
    });
  });

  it('rejects a whitespace-only selection inside a turn', () => {
    const [root, , leaf] = chain({}, { turnId: 'turn-7' }, {});
    assert.ok(root && leaf);
    assert.equal(resolveQuoteTarget('  \n ', leaf, root), null);
  });

  it('rejects real text that sits outside every turn', () => {
    const [root, , leaf] = chain({}, {}, {});
    assert.ok(root && leaf);
    assert.equal(resolveQuoteTarget('12:04 · 1.2k tokens', leaf, root), null);
  });

  it('rejects a selection spanning two turns', () => {
    // A cross-turn selection's common ancestor is the list that holds both
    // turns, so the walk from it meets no turn id before reaching the root.
    // Attributing the excerpt to either turn would misreport where it came
    // from, so the affordance is withheld — deliberately, and asserted here so
    // it is not later mistaken for an oversight.
    const [root, turnList] = chain({}, {});
    assert.ok(root && turnList);
    assert.equal(resolveQuoteTarget('spans both replies', turnList, root), null);
  });
});
