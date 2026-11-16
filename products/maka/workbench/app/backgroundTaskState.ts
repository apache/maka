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

import { cleanup, computed, effect, signal, untracked } from 'nsh';
import { errorText, renderText, UiError } from './text';
import {
  completed,
  followTerminalList,
  stopWatch,
  terminalRunning,
  type Watch,
} from './terminalList';
import { pendingTerminals, terminalMutation, type Host } from './host';
import type { ResourceUpdate } from '../../../../packages/plugin-sdk/src/index.js';
import type { ComposerBackgroundTask } from '../../../../packages/plugin-sdk/src/composer-view.js';

/**
 * Only background agent commands create ShellRun resources, so the Session's
 * agent-initiated shell runs are exactly its background tasks.
 */
export function backgroundTask(entry: ResourceUpdate, stoppable = false): ComposerBackgroundTask {
  const result = entry.result;
  return {
    ref: result.ref,
    command: result.cmd,
    status: result.status,
    startedAt: result.startedAt,
    ...(result.completedAt === undefined ? {} : { completedAt: result.completedAt }),
    ...(result.exitCode === undefined ? {} : { exitCode: result.exitCode }),
    stoppable,
  };
}

const ownTask = (sessionId: string, entry: ResourceUpdate) =>
  entry.sessionId === sessionId && entry.initiator === 'agent' && entry.result.kind === 'shell_run';

export function createBackgroundTasks(
  host: Pick<Host, 'subscribe' | 'query' | 'session'>,
  options: { sessionId: string; active(): boolean },
) {
  const entries = signal<ResourceUpdate[]>([]);
  const loading = signal(false);
  const error = signal<unknown>('');
  const stopFailure = signal<unknown>('');
  const stopping = signal<ReadonlySet<string>>(new Set());
  let alive = true;
  let watch: Watch<unknown> | null = null;
  const follow = () => {
    stopWatch(watch);
    const run: Watch<unknown> = { closed: false, stream: null };
    watch = run;
    const current = () => alive && options.active() && watch === run && !run.closed;
    loading.set(true);
    error.set('');
    void (async () => {
      try {
        await followTerminalList(host, options.sessionId, run, current, (resources) => {
          entries.set(resources.filter((entry) => ownTask(options.sessionId, entry)));
          loading.set(false);
        });
      } catch (reason) {
        if (current()) {
          console.warn('Could not load background tasks:', reason);
          error.set(new UiError('Could not load background tasks. Refresh to try again.'));
          loading.set(false);
        }
      } finally {
        stopWatch(run);
        if (watch === run) watch = null;
      }
    })();
  };
  effect(() => {
    const active = options.active();
    untracked(() => {
      if (active && !watch) follow();
      else if (!active) {
        stopWatch(watch);
        watch = null;
        loading.set(false);
      }
    });
  });
  cleanup(() => {
    alive = false;
    stopWatch(watch);
    watch = null;
  });
  // Shared Sessions are view only, as in the terminal pane.
  const stoppable = (entry: ResourceUpdate) =>
    options.active() && entry.ownership.kind === 'local' && terminalRunning(entry);
  const setStopping = (ref: string, value: boolean) => {
    const next = new Set(stopping());
    if (value) next.add(ref);
    else next.delete(ref);
    stopping.set(next);
  };
  const stop = async (ref: string) => {
    const entry = entries().find((candidate) => candidate.result.ref === ref);
    if (!alive || !entry || !stoppable(entry) || stopping().has(ref)) return;
    setStopping(ref, true);
    stopFailure.set('');
    try {
      const scope = host.session(options.sessionId);
      // Terminal mutations are admitted one at a time; never race an unconfirmed one.
      if ((await pendingTerminals(scope)).length > 0)
        throw new UiError(
          'An earlier terminal action is still being confirmed. Try again shortly.',
        );
      const stopped = completed(
        await terminalMutation(scope, 'stop', { sessionId: options.sessionId, ref }),
      ).resource;
      if (alive && ownTask(options.sessionId, stopped))
        entries.set(
          entries().map((candidate) => (candidate.result.ref === ref ? stopped : candidate)),
        );
    } catch (reason) {
      if (alive) stopFailure.set(reason);
    } finally {
      if (alive) setStopping(ref, false);
    }
  };
  const tasks = computed(() => entries().map((entry) => backgroundTask(entry)));
  return {
    running: computed(() =>
      entries()
        .filter(terminalRunning)
        .sort((a, b) => a.result.startedAt - b.result.startedAt)
        .map((entry) => backgroundTask(entry, stoppable(entry))),
    ),
    finished: computed(() =>
      tasks()
        .filter((task) => task.status !== 'starting' && task.status !== 'running')
        .sort((a, b) => (b.completedAt ?? b.startedAt) - (a.completedAt ?? a.startedAt)),
    ),
    loading,
    error: () =>
      renderText(errorText(error(), 'Could not load background tasks. Refresh to try again.')) ||
      renderText(errorText(stopFailure(), 'Could not stop the background task.')),
    refresh() {
      if (alive && options.active()) follow();
    },
    stop,
    stopping: (ref: string) => stopping().has(ref),
  };
}
export type BackgroundTasksModel = ReturnType<typeof createBackgroundTasks>;
