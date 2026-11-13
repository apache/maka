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

import { cleanup, computed, effect, signal } from 'nsh';
import type { HistoryRowAddress } from '../../../../packages/plugin-sdk/src/generated/runtime.js';
import type { AgentHistoryRequestsOutput_AgentHistoryRequest as HistoryRequest } from '../../../../packages/plugin-sdk/src/generated/methods.js';
import { historyTurnKey, type Row } from '../../../../products/maka/workbench/app/history';
import type { ScopedTrajectoryRequest } from '../../../../products/maka/workbench/app/trajectory';

type Trace = { through: number; finished: boolean; requests: HistoryRequest[] };
type Source = { turnKey: string; position: HistoryRowAddress };

export function createTrajectoryRequests(props: {
  active(): boolean;
  rows(): readonly Row[];
  through(): number | undefined;
  read(
    through: number,
    position: HistoryRowAddress,
    after?: number,
  ): Promise<{
    requests: HistoryRequest[];
    next?: number | null;
    runTerminated: boolean;
  }>;
  failed(reason: unknown): void;
}) {
  const traces = signal<ReadonlyMap<string, Trace>>(new Map());
  const failures = new Map<string, number>();
  const sources = computed(() => {
    const result = new Map<string, Source>();
    for (const row of props.rows()) {
      const turnKey = historyTurnKey(row);
      if (!turnKey || !row.runId || !row.position || row.position.kind === 'imported') continue;
      const key = JSON.stringify([turnKey, row.runId]);
      if (!result.has(key))
        result.set(key, {
          turnKey,
          position: row.position,
        });
    }
    return result;
  });
  let loading = false;
  let alive = true;
  cleanup(() => {
    alive = false;
  });

  effect(() => {
    if (!props.active()) {
      failures.clear();
      return;
    }
    const through = props.through();
    if (!through) return;
    const loaded = sources();
    const cached = traces();
    if (loading) return;
    const pending = [...loaded].findLast(([key]) => {
      if (failures.get(key) === through) return false;
      const trace = cached.get(key);
      return !trace || (!trace.finished && trace.through !== through);
    });
    if (!pending) return;
    const [key, source] = pending;
    const prior = cached.get(key);
    const requests: HistoryRequest[] = [];
    // Re-read a failed attempt until its retry starts or is cancelled.
    if (prior && prior.through <= through) {
      for (const request of prior.requests) {
        if (
          request.finished?.outcome !== 'success' &&
          request.retry?.kind !== 'started' &&
          request.retry?.kind !== 'cancelled'
        )
          break;
        requests.push(request);
      }
    }
    loading = true;
    void (async () => {
      let after = requests.at(-1)?.order.path.at(-1);
      let finished = source.position.kind === 'snapshot';
      try {
        do {
          const page = await props.read(through, source.position, after);
          if (!alive || !sources().has(key)) return;
          requests.push(...page.requests);
          after = page.next ?? undefined;
          finished ||= page.runTerminated;
        } while (after !== undefined);
        failures.delete(key);
      } catch (reason) {
        if (!alive) return;
        failures.set(key, through);
        props.failed(reason);
        return;
      } finally {
        loading = false;
        if (alive) {
          const current = new Map([...traces()].filter(([id]) => sources().has(id)));
          if (sources().has(key) && failures.get(key) !== through)
            current.set(key, { through, finished, requests });
          traces.set(current);
        }
      }
    })();
  });

  return computed<ScopedTrajectoryRequest[]>(() => {
    const cached = traces();
    return [...sources()].flatMap(([key, source]) =>
      (cached.get(key)?.requests ?? []).map((request) => ({ turnKey: source.turnKey, request })),
    );
  });
}
