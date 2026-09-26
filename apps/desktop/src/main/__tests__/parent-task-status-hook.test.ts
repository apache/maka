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

type ProbeProps = {
  sessionId: string | undefined;
  execution: SessionExecutionProjection | undefined;
  historyEpoch: number | undefined;
};

let commits: StatusCommit[] = [];

function StatusProbe(props: ProbeProps) {
  const status = useParentTaskStatus({
    sessionId: props.sessionId,
    execution: props.execution,
    historyEpoch: props.historyEpoch,
  });
  useLayoutEffect(() => {
    commits.push({ sessionId: props.sessionId, status });
  });
  return null;
}

function renderStatus(
  root: ReturnType<typeof installReactRenderer>['root'],
  services: WorkbarServices,
  props: Partial<ProbeProps> & { sessionId: string | undefined },
) {
  root.render(
    createElement(LocaleProvider, {
      locale: 'en',
      children: createElement(WorkbarServicesProvider, {
        services,
        children: createElement(StatusProbe, {
          execution: undefined,
          historyEpoch: 0,
          ...props,
        }),
      }),
    }),
  );
}

function lastStatus(): VisibleParentTaskStatus | null | undefined {
  return commits.at(-1)?.status;
}

/** The hook is props-driven: these readers stand in for the owning producers. */
function parentFacts(options?: {
  listTurns?: (sessionId: string) => Promise<TurnRecord[]>;
  onSubscribe?: () => void;
}) {
  const reads: string[] = [];
  const defaults = createFakeWorkbarServices();
  const services = createFakeWorkbarServices({
    sideChat: {
      ...defaults.sideChat,
      listTurns: async (sessionId) => {
        reads.push(sessionId);
        return options?.listTurns ? options.listTurns(sessionId) : [];
      },
      subscribeEvents: (
        _sessionId: string,
        _handler: (event: SessionEvent) => void,
        onReady?: () => void,
      ) => {
        options?.onSubscribe?.();
        onReady?.();
        return () => undefined;
      },
    },
  });
  return { services, reads };
}

const runningTurn = {
  sessionId: 'parent-1',
  turnId: 'turn-1',
  runId: 'run-1',
  status: 'running' as const,
};

function completedTurn(sessionId = 'parent-1') {
  return {
    sessionId,
    turnId: 'done',
    runId: 'run',
    status: 'completed' as const,
    terminalEventId: 'done',
  };
}

describe('useParentTaskStatus', () => {
  afterEach(() => {
    commits = [];
    cleanupFakeDom();
  });

  it('reports nothing and reads nothing before the owning projection arrives', async () => {
    const { root } = installReactRenderer();
    const facts = parentFacts();
    await act(async () => renderStatus(root, facts.services, { sessionId: 'parent-1' }));
    assert.equal(lastStatus(), null);
    assert.deepEqual(facts.reads, []);

    // A projection that reports itself unavailable is the real failure case.
    await act(async () =>
      renderStatus(root, facts.services, {
        sessionId: 'parent-1',
        execution: hostExecutionProjection(false, null),
      }),
    );
    assert.equal(lastStatus(), 'unavailable');
    assert.deepEqual(facts.reads, []);
  });

  it('reads nothing when no Side Conversation is visible', async () => {
    const { root } = installReactRenderer();
    const facts = parentFacts();
    await act(async () =>
      renderStatus(root, facts.services, {
        sessionId: undefined,
        execution: hostExecutionProjection(true, null),
      }),
    );
    assert.equal(lastStatus(), null);
    assert.deepEqual(facts.reads, []);
  });

  it('reads settled history once and stays silent while the read is in flight', async () => {
    const { root } = installReactRenderer();
    const turns = deferred<TurnRecord[]>();
    const facts = parentFacts({ listTurns: async () => turns.promise });
    const execution = hostExecutionProjection(true, null);
    await act(async () =>
      renderStatus(root, facts.services, { sessionId: 'parent-1', execution }),
    );
    assert.equal(lastStatus(), null, 'an initial history load is not unavailable');
    assert.deepEqual(facts.reads, ['parent-1']);

    await act(async () => {
      turns.resolve([{ turnId: 'done', status: 'completed' }]);
      await turns.promise;
    });
    assert.equal(lastStatus(), 'last_turn_completed');

    await act(async () =>
      renderStatus(root, facts.services, { sessionId: 'parent-1', execution }),
    );
    assert.deepEqual(facts.reads, ['parent-1'], 'equivalent projections do not reread');
  });

  it('reads the live root turn instead of history while the parent is busy', async () => {
    const { root } = installReactRenderer();
    const facts = parentFacts();
    await act(async () =>
      renderStatus(root, facts.services, {
        sessionId: 'parent-1',
        execution: hostExecutionProjection(true, runningTurn, ['permission']),
      }),
    );
    assert.equal(lastStatus(), 'waiting_approval');
    assert.deepEqual(facts.reads, []);
  });

  it('retries a failed read on a bounded backoff, then reports unavailable', async (context) => {
    context.mock.timers.enable({ apis: ['setTimeout'] });
    const { root } = installReactRenderer();
    const facts = parentFacts({
      listTurns: async () => {
        throw new Error('listTurns rejected');
      },
    });
    const execution = hostExecutionProjection(true, null);
    await act(async () =>
      renderStatus(root, facts.services, { sessionId: 'parent-1', execution }),
    );
    assert.equal(facts.reads.length, 1);
    assert.equal(lastStatus(), null, 'a first failure is still a load, not a verdict');

    await act(async () => context.mock.timers.tick(99));
    assert.equal(facts.reads.length, 1, 'no early retry');
    await act(async () => context.mock.timers.tick(1));
    assert.equal(facts.reads.length, 2);
    assert.equal(lastStatus(), null);

    await act(async () => context.mock.timers.tick(199));
    assert.equal(facts.reads.length, 2);
    await act(async () => context.mock.timers.tick(1));
    assert.equal(facts.reads.length, 3);
    assert.equal(lastStatus(), 'unavailable');

    await act(async () => context.mock.timers.tick(60_000));
    assert.equal(facts.reads.length, 3, 'auto recovery is bounded');
  });

  it('recovers without a new Host frame when the producer invalidates history', async (context) => {
    context.mock.timers.enable({ apis: ['setTimeout'] });
    const { root } = installReactRenderer();
    let attempt = 0;
    const facts = parentFacts({
      listTurns: async () => {
        attempt += 1;
        if (attempt === 1) throw new Error('listTurns rejected');
        return [{ turnId: 'recovered', status: 'failed' }];
      },
    });
    const execution = hostExecutionProjection(true, null);
    await act(async () =>
      renderStatus(root, facts.services, { sessionId: 'parent-1', execution, historyEpoch: 0 }),
    );
    assert.equal(facts.reads.length, 1);
    // The producer reports a new invalidation revision before the retry fires.
    await act(async () =>
      renderStatus(root, facts.services, { sessionId: 'parent-1', execution, historyEpoch: 1 }),
    );
    assert.equal(facts.reads.length, 2);
    assert.equal(lastStatus(), 'last_turn_failed');
    await act(async () => context.mock.timers.tick(60_000));
    assert.equal(facts.reads.length, 2, 'the superseded attempt never fires again');
  });

  it('drops a history result that belongs to a superseded revision', async () => {
    const { root } = installReactRenderer();
    const first = deferred<TurnRecord[]>();
    const second = deferred<TurnRecord[]>();
    let reads = 0;
    const facts = parentFacts({
      listTurns: async () => (++reads === 1 ? first.promise : second.promise),
    });
    const execution = hostExecutionProjection(true, null);
    await act(async () =>
      renderStatus(root, facts.services, { sessionId: 'parent-1', execution, historyEpoch: 0 }),
    );
    await act(async () =>
      renderStatus(root, facts.services, { sessionId: 'parent-1', execution, historyEpoch: 1 }),
    );
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

  it('cancels the pending read when a live root turn appears', async () => {
    const { root } = installReactRenderer();
    const turns = deferred<TurnRecord[]>();
    const facts = parentFacts({ listTurns: async () => turns.promise });
    await act(async () =>
      renderStatus(root, facts.services, {
        sessionId: 'parent-1',
        execution: hostExecutionProjection(true, null),
      }),
    );
    assert.deepEqual(facts.reads, ['parent-1']);
    await act(async () =>
      renderStatus(root, facts.services, {
        sessionId: 'parent-1',
        execution: hostExecutionProjection(true, runningTurn),
      }),
    );
    assert.equal(lastStatus(), 'running');
    await act(async () => {
      turns.resolve([{ turnId: 'stale', status: 'failed' }]);
      await turns.promise;
    });
    assert.equal(lastStatus(), 'running');
  });

  it('never shows one Session the answer read for another', async () => {
    const { root } = installReactRenderer();
    const first = deferred<TurnRecord[]>();
    const second = deferred<TurnRecord[]>();
    const facts = parentFacts({
      listTurns: async (sessionId) => (sessionId === 'parent-1' ? first.promise : second.promise),
    });
    await act(async () =>
      renderStatus(root, facts.services, {
        sessionId: 'parent-1',
        execution: hostExecutionProjection(true, null),
      }),
    );
    await act(async () =>
      renderStatus(root, facts.services, {
        sessionId: 'parent-2',
        execution: hostExecutionProjection(true, null),
      }),
    );
    assert.equal(lastStatus(), null);
    await act(async () => {
      first.resolve([{ turnId: 'stale', status: 'completed' }]);
      await first.promise;
    });
    assert.equal(lastStatus(), null, 'the previous Session’s read is fenced out');
    await act(async () => {
      second.resolve([{ turnId: 'fresh', status: 'failed' }]);
      await second.promise;
    });
    assert.equal(lastStatus(), 'last_turn_failed');
  });

  it('ignores a late read after unmount', async () => {
    const { root } = installReactRenderer();
    const turns = deferred<TurnRecord[]>();
    const facts = parentFacts({ listTurns: async () => turns.promise });
    await act(async () =>
      renderStatus(root, facts.services, {
        sessionId: 'parent-1',
        execution: hostExecutionProjection(true, null),
      }),
    );
    await act(async () => root.unmount());
    const afterUnmount = commits.length;
    await act(async () => {
      turns.resolve([{ turnId: 'late', status: 'completed' }]);
      await turns.promise;
    });
    assert.equal(commits.length, afterUnmount);
  });

  it('registers no extra Host observation of its own', async () => {
    const { root } = installReactRenderer();
    let subscriptions = 0;
    const facts = parentFacts({
      onSubscribe: () => {
        subscriptions += 1;
      },
    });
    await act(async () =>
      renderStatus(root, facts.services, {
        sessionId: 'parent-1',
        execution: hostExecutionProjection(true, null),
      }),
    );
    assert.deepEqual(facts.reads, ['parent-1']);
    assert.equal(subscriptions, 0);
  });
});
