/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

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

  it('rejects a selection that holds nothing but whitespace', () => {
    assert.equal(normalizeQuoteText('   \n\t '), null);
    assert.equal(normalizeQuoteText(''), null);
  });
});

describe('findEnclosingTurnId', () => {



  it('stops at the root rather than adopting a turn id above it', () => {
    const [ancestorTurn, root, leaf] = chain({ turnId: 'turn-above-root' }, {}, {});
    assert.ok(ancestorTurn && root && leaf);
    assert.equal(findEnclosingTurnId(leaf, root), null);
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
