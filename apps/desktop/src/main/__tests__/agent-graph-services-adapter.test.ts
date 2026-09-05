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
import type { MakaBridge } from '../../preload/bridge-contract.js';
import { createDesktopAgentGraphServices } from '../../renderer/platform/desktop/create-agent-graph-services.js';

describe('createDesktopAgentGraphServices', () => {
  it('maps the narrow Graph contract to the Desktop bridge', async () => {
    const calls: Array<{ name: string; args: unknown[] }> = [];
    let changeHandler: (() => void) | undefined;
    let changes = 0;
    let disposed = 0;
    const graphs = new Proxy(
      {},
      {
        get: (_target, property) =>
          (...args: unknown[]) => {
            calls.push({ name: String(property), args });
            if (property === 'subscribe') {
              changeHandler = args[1] as () => void;
              return () => {
                disposed += 1;
              };
            }
            return Promise.resolve(property);
          },
      },
    );
    const services = createDesktopAgentGraphServices({ graphs } as unknown as Pick<
      MakaBridge,
      'graphs'
    >);

    await services.graphs.listEpochs('session-1');
    await services.graphs.listCurrentEpochs('session-1');
    await services.graphs.getSnapshot('session-1', { graphId: 'graph-1' });
    await services.graphs.inspectOperator('session-1', 'operator-1', 'graph-1');
    await services.graphs.stop('session-1', 'graph-1');
    const unsubscribe = services.graphs.subscribe('session-1', () => {
      changes += 1;
    });
    changeHandler?.();
    unsubscribe();

    assert.deepEqual(calls, [
      { name: 'listEpochs', args: ['session-1'] },
      { name: 'listCurrentEpochs', args: ['session-1'] },
      { name: 'getSnapshot', args: ['session-1', { graphId: 'graph-1' }] },
      { name: 'inspectOperator', args: ['session-1', 'operator-1', 'graph-1'] },
      { name: 'stop', args: ['session-1', 'graph-1'] },
      { name: 'subscribe', args: ['session-1', changeHandler] },
    ]);
    assert.equal(changes, 1);
    assert.equal(disposed, 1);
  });
});
