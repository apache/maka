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
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { test } from 'node:test';
import { act, createElement, StrictMode, useCallback, useEffect, useRef } from 'react';
import { parse } from '@babel/parser';
import type { ActiveInteractionRequestEvent } from '@maka/core/events';
import { reconcileInteractions, type InteractionQueues } from '@maka/ui';
import { cleanupFakeDom, installReactRenderer } from './fake-dom.js';

// Execute the actual AppShell hook statements in React without mounting the
// rest of the application or adding a production abstraction just for tests.
function hydrationScope() {
  const source = readFileSync(
    new URL('../../../src/renderer/app-shell.tsx', import.meta.url), 'utf8',
  );
  const file = parse(source, { sourceType: 'module', plugins: ['typescript', 'jsx'] });
  const shell = file.program.body.find((statement) =>
    statement.type === 'FunctionDeclaration' && statement.id?.name === 'AppShellContent');
  assert.ok(shell?.type === 'FunctionDeclaration');
  const selected = shell.body.body.filter((statement) => {
    if (statement.type === 'VariableDeclaration') return statement.declarations.some(
      (declaration) => declaration.id.type === 'Identifier'
        && /^(interactionHydration(?:Epoch)?Ref|markInteractionChanged)$/.test(declaration.id.name),
    );
    return statement.type === 'ExpressionStatement' && statement.expression.type === 'CallExpression'
      && statement.expression.callee.type === 'Identifier' && statement.expression.callee.name === 'useEffect'
      && source.slice(statement.start!, statement.end!).includes('.listActiveInteractions(');
  });
  assert.equal(selected.length, 3, 'the ref, invalidator and hydration effect must all be exercised');
  const scope = selected.map((statement) => source.slice(statement.start!, statement.end!)).join('\n');
  const compiled = stripTypeScriptTypes(`function useScope(ownerActiveId, sessionUiController) { ${scope}\nreturn markInteractionChanged; }`);
  return new Function('useRef', 'useEffect', 'useCallback', 'reconcileInteractions',
    compiled + '\nreturn useScope;\n//# sourceURL=maka-hydration-scope.js')(
    useRef, useEffect, useCallback, reconcileInteractions,
  ) as (sessionId: string | undefined, controller: {
    setInteractionBySession(update: (current: InteractionQueues) => InteractionQueues): void;
  }) => (sessionId: string) => void;
}

function request(id: string): ActiveInteractionRequestEvent {
  return { type: 'form_request', id, turnId: 'turn', ts: 1, requestId: id,
    toolUseId: 'tool', message: id, requester: { name: 'test' }, fields: [] };
}

test('active interaction hydration fences late reads without retaining past Session epochs', async () => {
  const useHydration = hydrationScope();
  const { root } = installReactRenderer();
  const reads: { sessionId: string; resolve(value: ActiveInteractionRequestEvent[]): void; reject(error: Error): void }[] = [];
  Object.defineProperty(window, 'maka', { configurable: true, value: { sessions: {
    listActiveInteractions: (sessionId: string) => new Promise<ActiveInteractionRequestEvent[]>((resolve, reject) => {
      reads.push({ sessionId, resolve, reject });
    }),
  } } });
  let queues: InteractionQueues = {};
  let writes = 0;
  const setInteractions = (update: (current: InteractionQueues) => InteractionQueues) => {
    writes++; queues = update(queues);
  };
  let markChanged!: (sessionId: string) => void;
  function Harness({ sessionId }: { sessionId?: string }) {
    markChanged = useHydration(sessionId, { setInteractionBySession: setInteractions });
    return null;
  }
  const render = (sessionId?: string) => act(async () => {
    root.render(createElement(StrictMode, null, createElement(Harness, { sessionId })));
  });
  const originalSet = Map.prototype.set;
  const observed = new Set<Map<unknown, unknown>>();
  Map.prototype.set = function (key: unknown, value: unknown) {
    if ((new Error().stack ?? '').split('\n')[2]?.includes('maka-hydration-scope.js:')) {
      observed.add(this);
    }
    return Reflect.apply(originalSet, this, [key, value]);
  };
  try {
    await render('A');
    assert.equal(reads.length, 2, 'StrictMode must start a fresh read after effect cleanup');
    const stableMark = markChanged;
    await act(async () => { reads[0]!.resolve([request('stale-strict')]); });
    assert.equal(writes, 0);
    await act(async () => { reads[1]!.resolve([request('fresh-A')]); });
    assert.equal(queues.A?.[0]?.requestId, 'fresh-A');
    for (let i = 0; i < 10_000; i++) markChanged('past-' + i);

    await render('B');
    assert.equal(markChanged, stableMark);
    markChanged('A');
    markChanged('unknown');
    await act(async () => { reads[2]!.resolve([request('fresh-B')]); });
    assert.equal(queues.B?.[0]?.requestId, 'fresh-B', 'another Session must not invalidate B');

    await render('C');
    markChanged('C');
    const beforeLive = writes;
    await act(async () => { reads[3]!.resolve([request('stale-C')]); });
    assert.equal(writes, beforeLive, 'newer live interaction state must win');

    await render('A');
    await render('B');
    await render('A');
    await act(async () => { reads[4]!.resolve([request('stale-A')]); reads[5]!.reject(new Error('stale-B')); });
    assert.equal(writes, beforeLive, 'late cleanup cannot revive a superseded read');
    await act(async () => { reads[6]!.resolve([request('newest-A')]); });
    assert.equal(queues.A?.[0]?.requestId, 'newest-A', 'late settlement must not release the replacement');

    await render('rejected');
    await act(async () => { reads[7]!.reject(new Error('offline')); });
    const beforeRejected = writes;
    await render();
    for (let i = 0; i < 10_000; i++) markChanged('retired-' + i);
    assert.equal(reads.length, 8, 'no Host read is made without an owner Session');
    assert.equal(writes, beforeRejected);
    const retainedWhileMounted = [...observed].reduce((total, map) => total + map.size, 0);
    await render('unmounted');
    await act(async () => { root.unmount(); });
    await act(async () => { reads[8]!.resolve([request('after-unmount')]); });
    assert.equal(writes, beforeRejected);
    // Old production epoch-map logic passes the races, then fails this memory assertion.
    assert.equal(retainedWhileMounted, 0,
      'completed/unknown Sessions must not accumulate hydration metadata');
  } finally {
    Map.prototype.set = originalSet;
    cleanupFakeDom();
  }
});
