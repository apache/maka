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

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  auditAxTree,
  findAmbiguousActionableAxNodes,
  findMissingActionableState,
  findUnnamedRequiredContainers,
} from './ax-tree-audit.mjs';

function value(value) {
  return { value };
}

test('rejects trees whose only source records are ignored', () => {
  const audit = auditAxTree([
    { nodeId: 'root', ignored: true },
    { nodeId: 'hidden', ignored: true, parentId: 'root' },
  ]);
  assert.equal(audit.sourceNodeCount, 2);
  assert.equal(audit.exposedNodeCount, 0);
  assert.ok(audit.problems.some((problem) => problem.code === 'empty_ax_tree'));
});

test('rejects a document shell whose application subtree is fully ignored', () => {
  const audit = auditAxTree([
    { nodeId: 'document', role: value('RootWebArea'), name: value('Maka') },
    { nodeId: 'app', parentId: 'document', ignored: true },
  ]);
  assert.equal(audit.exposedNodeCount, 1);
  assert.equal(audit.applicationNodeCount, 0);
  assert.ok(audit.problems.some((problem) => problem.code === 'empty_ax_tree'));
});

test('rejects duplicate actions in the same named scope', () => {
  const nodes = [
    { nodeId: 'root', role: value('navigation'), name: value('Tasks') },
    {
      nodeId: 'a',
      parentId: 'root',
      backendDOMNodeId: 1,
      role: value('button'),
      name: value('Task actions'),
    },
    {
      nodeId: 'b',
      parentId: 'root',
      backendDOMNodeId: 2,
      role: value('button'),
      name: value('Task actions'),
    },
  ];
  assert.deepEqual(findAmbiguousActionableAxNodes(nodes), [
    {
      role: 'button',
      name: 'Task actions',
      scope: 'navigation:Tasks',
      count: 2,
      backendDOMNodeIds: [1, 2],
    },
  ]);
});

test('allows the same action name in distinct named dialogs', () => {
  const nodes = [
    { nodeId: 'one', role: value('dialog'), name: value('First') },
    { nodeId: 'two', role: value('dialog'), name: value('Second') },
    { nodeId: 'a', parentId: 'one', role: value('button'), name: value('Close') },
    { nodeId: 'b', parentId: 'two', role: value('button'), name: value('Close') },
  ];
  assert.deepEqual(findAmbiguousActionableAxNodes(nodes), []);
});

test('uses visible status content to distinguish repeated dismiss actions', () => {
  const nodes = [
    { nodeId: 'one', role: value('status'), name: value(''), childIds: ['one-title', 'a'] },
    { nodeId: 'one-title', parentId: 'one', role: value('StaticText'), name: value('Saved') },
    { nodeId: 'two', role: value('status'), name: value(''), childIds: ['two-title', 'b'] },
    { nodeId: 'two-title', parentId: 'two', role: value('StaticText'), name: value('Failed') },
    { nodeId: 'a', parentId: 'one', role: value('button'), name: value('Close') },
    { nodeId: 'b', parentId: 'two', role: value('button'), name: value('Close') },
  ];
  assert.deepEqual(findAmbiguousActionableAxNodes(nodes), []);
});

test('does not merge long scope names that differ after the diagnostic limit', () => {
  const prefix = 'x'.repeat(180);
  const nodes = [
    { nodeId: 'one', role: value('status'), name: value(`${prefix}-one`) },
    { nodeId: 'two', role: value('status'), name: value(`${prefix}-two`) },
    { nodeId: 'a', parentId: 'one', role: value('button'), name: value('Close') },
    { nodeId: 'b', parentId: 'two', role: value('button'), name: value('Close') },
  ];
  assert.deepEqual(findAmbiguousActionableAxNodes(nodes), []);
});

test('audits large trees without rescanning non-scope ancestor subtrees', () => {
  const buttonCount = 800;
  const childIds = Array.from({ length: buttonCount }, (_, index) => `button-${index}`);
  let wrapperSubtreeReads = 0;
  const nodes = [
    { nodeId: 'root', role: value('main'), name: value('Catalog'), childIds: ['wrapper'] },
    {
      nodeId: 'wrapper',
      parentId: 'root',
      role: value('generic'),
      get childIds() {
        wrapperSubtreeReads += 1;
        return childIds;
      },
    },
    ...childIds.map((nodeId, index) => ({
      nodeId,
      parentId: 'wrapper',
      role: value('button'),
      name: value(`Action ${index}`),
    })),
  ];
  assert.deepEqual(findAmbiguousActionableAxNodes(nodes), []);
  assert.equal(wrapperSubtreeReads, 0);
});

test('requires state on state-bearing controls', () => {
  const nodes = [
    { role: value('checkbox'), name: value('Remember me'), properties: [] },
    {
      role: value('tab'),
      name: value('Details'),
      properties: [{ name: 'selected', value: value(false) }],
    },
  ];
  assert.deepEqual(findMissingActionableState(nodes), [
    {
      role: 'checkbox',
      name: 'Remember me',
      property: 'checked',
    },
  ]);
  assert.ok(
    auditAxTree(nodes).problems.some((problem) => problem.code === 'missing_actionable_state'),
  );
});

test('requires expanded state on controls that own a disclosure target', () => {
  const nodes = [
    {
      role: value('button'),
      name: value('Details'),
      properties: [{ name: 'controls', value: value(['details-panel']) }],
    },
    {
      role: value('button'),
      name: value('Advanced'),
      properties: [
        { name: 'controls', value: value(['advanced-panel']) },
        { name: 'expanded', value: value(false) },
      ],
    },
  ];
  assert.deepEqual(findMissingActionableState(nodes), [
    {
      role: 'button',
      name: 'Details',
      property: 'expanded',
    },
  ]);
});

test('does not treat a tab panel relationship as a disclosure', () => {
  assert.deepEqual(
    findMissingActionableState([
      {
        role: value('tab'),
        name: value('Details'),
        properties: [
          { name: 'controls', value: value(['details-panel']) },
          { name: 'selected', value: value(false) },
        ],
      },
    ]),
    [],
  );
});

test('requires names on dialogs', () => {
  assert.deepEqual(
    findUnnamedRequiredContainers([
      { role: value('dialog'), name: value(''), backendDOMNodeId: 7 },
    ]),
    [{ role: 'dialog', backendDOMNodeId: 7 }],
  );
});
