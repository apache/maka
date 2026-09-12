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

import { deferred } from '@maka/core/test-only/async-primitives';
import { strict as assert } from 'node:assert';
import { afterEach, describe, it } from 'node:test';
import { act, createElement, useLayoutEffect } from 'react';
import type { SessionEvent } from '@maka/core/events';
import type { TurnRecord } from '@maka/core/session';
import { LocaleProvider } from '@maka/ui';
import { cleanupFakeDom, installReactRenderer } from './fake-dom.js';
import {
  createFakeWorkbarServices,
  hostExecutionProjection,
  useParentTaskStatus,
  WorkbarServicesProvider,
  type SessionExecutionProjection,
  type VisibleParentTaskStatus,
  type WorkbarServices,
} from '../../renderer/features/workbar/testing.js';

type StatusCommit = {
  readonly sessionId: string | undefined;
  readonly status: VisibleParentTaskStatus | null;
};

let commits: StatusCommit[] = [];

function StatusProbe(props: { sessionId: string | undefined }) {
  const status = useParentTaskStatus(props.sessionId);
  useLayoutEffect(() => {
    commits.push({ sessionId: props.sessionId, status });
  });
  return null;
}

function renderStatus(
  root: ReturnType<typeof installReactRenderer>['root'],
  services: WorkbarServices,
  sessionId: string | undefined,
) {
  root.render(
    createElement(LocaleProvider, {
      locale: 'en',
      children: createElement(WorkbarServicesProvider, {
        services,
        children: createElement(StatusProbe, { sessionId }),
      }),
    }),
  );
}

function lastStatus(): VisibleParentTaskStatus | null | undefined {
  return commits.at(-1)?.status;
}

function statusesFor(sessionId: string | undefined, from = 0): Array<VisibleParentTaskStatus | null> {
  return commits.slice(from).filter((commit) => commit.sessionId === sessionId).map((commit) => commit.status);
}

type ExecutionHandler = (projection: SessionExecutionProjection | undefined) => void;

function parentObservation(options?: {
  listTurns?: (sessionId: string) => Promise<TurnRecord[]>;
}) {
  const executionHandlers: ExecutionHandler[] = [];
  let onSeedError: ((error: unknown) => void) | undefined;
  const subscribed: string[] = [];
  let unsubscribed = 0;
  const listTurnsCalls: string[] = [];
  const turns = deferred<TurnRecord[]>();
  const defaults = createFakeWorkbarServices();
  const services = createFakeWorkbarServices({
    sideChat: {
      ...defaults.sideChat,
      listTurns: async (sessionId) => {
        listTurnsCalls.push(sessionId);
        if (options?.listTurns) return options.listTurns(sessionId);
        return turns.promise;
      },
      subscribeEvents: (sessionId, _handler: (event: SessionEvent) => void, onSeeded, seedError, execution) => {
        subscribed.push(sessionId);
        if (execution) executionHandlers.push(execution);
        onSeedError = seedError;
        onSeeded?.();
        return () => {
          unsubscribed += 1;
        };
      },
    },
  });
  return {
    services,
    subscribed,
    get unsubscribed() { return unsubscribed; },
    listTurnsCalls,
    turns,
    seed(projection: SessionExecutionProjection) {
      executionHandlers.at(-1)?.(projection);
    },
    seedAt(index: number, projection: SessionExecutionProjection) {
      executionHandlers[index]?.(projection);
    },
    fail(error: unknown = new Error('observation failed')) {
      onSeedError?.(error);
    },
  };
}

const completedTurn = {
  sessionId: 'parent-1',
  turnId: 'done',
  runId: 'run',
  status: 'completed' as const,
  terminalEventId: 'done',
};

describe('useParentTaskStatus', () => {
  afterEach(() => {
    commits = [];
    cleanupFakeDom();
    delete (globalThis as { window?: unknown }).window;
  });

  it('hydrates from seed, then listTurns when rootTurn is empty', async () => {
    const { root } = installReactRenderer();
    const observation = parentObservation();
    await act(async () => renderStatus(root, observation.services, 'parent-1'));
    assert.equal(lastStatus(), 'unavailable');
    await act(async () => {
      observation.seed(hostExecutionProjection(true, null));
    });
    assert.equal(lastStatus(), 'unavailable');
    await act(async () => {
      observation.turns.resolve([{ turnId: 'done', status: 'completed' }]);
      await observation.turns.promise;
    });
    assert.equal(lastStatus(), 'last_turn_completed');
    assert.deepEqual(observation.listTurnsCalls, ['parent-1']);
  });

  it('does not reread equivalent projections while Host still has no rootTurn', async () => {
    const { root } = installReactRenderer();
    const observation = parentObservation();
    await act(async () => renderStatus(root, observation.services, 'parent-1'));
    await act(async () => {
      observation.seed(hostExecutionProjection(true, null));
    });
    await act(async () => {
      observation.turns.resolve([{ turnId: 'done', status: 'completed' }]);
      await observation.turns.promise;
    });
    assert.equal(lastStatus(), 'last_turn_completed');
    const calls = observation.listTurnsCalls.length;
    await act(async () => {
      observation.seed(hostExecutionProjection(true, null));
    });
    assert.equal(observation.listTurnsCalls.length, calls);
    assert.equal(lastStatus(), 'last_turn_completed');
  });

  it('maps pending approval on a live seed without treating companion queues as parent', async () => {
    const { root } = installReactRenderer();
    const observation = parentObservation();
    await act(async () => renderStatus(root, observation.services, 'parent-1'));
    await act(async () => {
      observation.seed(hostExecutionProjection(true, {
        sessionId: 'parent-1',
        turnId: 'turn-1',
        runId: 'run-1',
        status: 'waiting_for_user',
      }, ['permission']));
    });
    assert.equal(lastStatus(), 'waiting_approval');
    assert.deepEqual(observation.listTurnsCalls, []);
  });

  it('marks unavailable on reconnect pending and recovers on the next seed', async () => {
    const { root } = installReactRenderer();
    const observation = parentObservation();
    await act(async () => renderStatus(root, observation.services, 'parent-1'));
    await act(async () => {
      observation.seed(hostExecutionProjection(true, completedTurn));
    });
    assert.equal(lastStatus(), 'last_turn_completed');
    await act(async () => {
      observation.seed(hostExecutionProjection(false, completedTurn));
    });
    assert.equal(lastStatus(), 'unavailable');
    await act(async () => {
      observation.seed(hostExecutionProjection(true, {
        sessionId: 'parent-1',
        turnId: 'turn-2',
        runId: 'run-2',
        status: 'running',
      }));
    });
    assert.equal(lastStatus(), 'running');
  });

  it('never commits the previous Session success onto a replacement Session', async () => {
    const { root } = installReactRenderer();
    const firstTurns = deferred<TurnRecord[]>();
    const observation = parentObservation({
      listTurns: async (sessionId) => {
        if (sessionId === 'parent-1') return firstTurns.promise;
        return [];
      },
    });
    await act(async () => renderStatus(root, observation.services, 'parent-1'));
    await act(async () => {
      observation.seed(hostExecutionProjection(true, completedTurn));
    });
    assert.equal(lastStatus(), 'last_turn_completed');
    const afterCompleted = commits.length;
    await act(async () => renderStatus(root, observation.services, 'parent-2'));
    const bStatuses = statusesFor('parent-2', afterCompleted);
    assert.ok(bStatuses.length > 0);
    for (const status of bStatuses) {
      assert.notEqual(status, 'last_turn_completed');
    }
    await act(async () => {
      observation.seed(hostExecutionProjection(true, {
        sessionId: 'parent-2',
        turnId: 'live',
        runId: 'run',
        status: 'running',
      }));
    });
    assert.equal(lastStatus(), 'running');
    await act(async () => {
      observation.seedAt(0, hostExecutionProjection(true, completedTurn));
      firstTurns.resolve([{ turnId: 'stale', status: 'completed' }]);
      await firstTurns.promise.catch(() => undefined);
    });
    assert.equal(lastStatus(), 'running');
    for (const status of statusesFor('parent-2', afterCompleted)) {
      assert.notEqual(status, 'last_turn_completed');
    }
  });

  it('drops parent status on the first committed render after sessionId is cleared', async () => {
    const { root } = installReactRenderer();
    const observation = parentObservation();
    await act(async () => renderStatus(root, observation.services, 'parent-1'));
    await act(async () => {
      observation.seed(hostExecutionProjection(true, completedTurn));
    });
    const afterCompleted = commits.length;
    await act(async () => renderStatus(root, observation.services, undefined));
    const cleared = statusesFor(undefined, afterCompleted);
    assert.ok(cleared.length > 0);
    for (const status of cleared) {
      assert.equal(status, null);
    }
  });

  it('does not show the replacement Session on A after A to B to A', async () => {
    const { root } = installReactRenderer();
    const observation = parentObservation();
    await act(async () => renderStatus(root, observation.services, 'parent-1'));
    await act(async () => {
      observation.seed(hostExecutionProjection(true, completedTurn));
    });
    await act(async () => renderStatus(root, observation.services, 'parent-2'));
    await act(async () => {
      observation.seed(hostExecutionProjection(true, {
        sessionId: 'parent-2',
        turnId: 'live',
        runId: 'run',
        status: 'running',
      }));
    });
    const afterB = commits.length;
    await act(async () => renderStatus(root, observation.services, 'parent-1'));
    const returned = statusesFor('parent-1', afterB);
    assert.ok(returned.length > 0);
    for (const status of returned) {
      assert.notEqual(status, 'running');
    }
    assert.equal(lastStatus(), 'unavailable');
  });

  it('unsubscribes on unmount and ignores a late seed', async () => {
    const { root } = installReactRenderer();
    const observation = parentObservation();
    await act(async () => renderStatus(root, observation.services, 'parent-1'));
    assert.equal(observation.unsubscribed, 0);
    await act(async () => root.unmount());
    assert.equal(observation.unsubscribed, 1);
    const afterUnmount = commits.length;
    await act(async () => {
      observation.seed(hostExecutionProjection(true, {
        sessionId: 'parent-1',
        turnId: 'late',
        runId: 'run',
        status: 'failed',
        terminalEventId: 'fail',
        failureClass: 'provider',
      }));
    });
    assert.equal(commits.length, afterUnmount);
  });

  it('refreshes latest turn after reconnect notifications in one React batch', async () => {
    const { root } = installReactRenderer();
    let reads = 0;
    const observation = parentObservation({
      listTurns: async () => {
        reads += 1;
        return [{ turnId: String(reads), status: reads === 1 ? 'completed' : 'failed' }];
      },
    });
    await act(async () => renderStatus(root, observation.services, 'parent-1'));
    await act(async () => observation.seed(hostExecutionProjection(true, null)));
    assert.equal(lastStatus(), 'last_turn_completed');
    await act(async () => {
      observation.seed(hostExecutionProjection(false, null));
      observation.seed(hostExecutionProjection(true, null));
    });
    assert.equal(reads, 2, 'reconnected host must refresh settled turn facts');
    assert.equal(lastStatus(), 'last_turn_failed');
  });

  it('does not reread equivalent projections batched with a reconnect', async () => {
    const { root } = installReactRenderer();
    let reads = 0;
    const observation = parentObservation({
      listTurns: async () => {
        reads += 1;
        return [{ turnId: String(reads), status: 'completed' }];
      },
    });
    await act(async () => renderStatus(root, observation.services, 'parent-1'));
    await act(async () => observation.seed(hostExecutionProjection(true, null)));
    assert.equal(reads, 1);
    await act(async () => {
      observation.seed(hostExecutionProjection(true, null));
      observation.seed(hostExecutionProjection(true, null));
    });
    assert.equal(reads, 1);
    assert.equal(lastStatus(), 'last_turn_completed');
  });

  it('invalidates history when a live root disappears in the same batch', async () => {
    const { root } = installReactRenderer();
    let reads = 0;
    const observation = parentObservation({
      listTurns: async () => {
        reads += 1;
        return [{ turnId: String(reads), status: 'failed' }];
      },
    });
    await act(async () => renderStatus(root, observation.services, 'parent-1'));
    await act(async () => {
      observation.seed(hostExecutionProjection(true, {
        sessionId: 'parent-1',
        turnId: 'live',
        runId: 'run',
        status: 'running',
      }));
    });
    assert.equal(reads, 0);
    await act(async () => {
      observation.seed(hostExecutionProjection(true, {
        sessionId: 'parent-1',
        turnId: 'live',
        runId: 'run',
        status: 'running',
      }));
      observation.seed(hostExecutionProjection(true, null));
    });
    assert.equal(reads, 1);
    assert.equal(lastStatus(), 'last_turn_failed');
  });

  it('drops a stale listTurns result after a newer history epoch', async () => {
    const { root } = installReactRenderer();
    const first = deferred<TurnRecord[]>();
    const second = deferred<TurnRecord[]>();
    let reads = 0;
    const observation = parentObservation({
      listTurns: async () => {
        reads += 1;
        return reads === 1 ? first.promise : second.promise;
      },
    });
    await act(async () => renderStatus(root, observation.services, 'parent-1'));
    await act(async () => observation.seed(hostExecutionProjection(true, null)));
    assert.equal(reads, 1);
    await act(async () => {
      observation.seed(hostExecutionProjection(false, null));
      observation.seed(hostExecutionProjection(true, null));
    });
    assert.equal(reads, 2);
    await act(async () => {
      first.resolve([{ turnId: 'stale', status: 'completed' }]);
      await first.promise;
    });
    assert.notEqual(lastStatus(), 'last_turn_completed');
    await act(async () => {
      second.resolve([{ turnId: 'fresh', status: 'failed' }]);
      await second.promise;
    });
    assert.equal(lastStatus(), 'last_turn_failed');
  });
});
