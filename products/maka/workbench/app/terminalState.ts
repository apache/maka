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

import { errorText, renderText, UiError } from './text';
import { cleanup, effect, signal, untracked, type Signal } from 'nsh';
import { TerminalGrid } from 'maka/host';
import { terminalMutation, pendingTerminals, recoverTerminal, abandonTerminal } from './host';
import type { Host, ScopedHost } from './host';
import { tr } from './locale';
import type {
  ClientOperation,
  OperationReply,
  RawAction,
  ResourceUpdate,
  TerminalSize,
} from '../../../../packages/plugin-sdk/src/index.js';

type Stream<T> = { next(): Promise<T | null>; close(): Promise<void> };
type Watch<T> = { closed: boolean; stream: Stream<T> | null };
type TerminalRow = { value: Signal<ResourceUpdate> };
type TerminalTarget = { sessionId: string; ref: string };
export function terminalStatus(status: ResourceUpdate['result']['status']): string {
  switch (status) {
    case 'starting':
      return tr('starting');
    case 'running':
      return tr('running');
    case 'completed':
      return tr('completed');
    case 'failed':
      return tr('failed');
    case 'timed_out':
      return tr('timed_out');
    case 'cancelled':
      return tr('cancelled');
    case 'orphaned':
      return tr('orphaned');
  }
}
export function completed<T>(
  outcome: { kind: 'completed'; value: T } | { kind: 'failed'; message: string },
): T {
  if (outcome.kind === 'failed') throw new Error(outcome.message);
  return outcome.value;
}
const running = (entry: ResourceUpdate) => ['starting', 'running'].includes(entry.result.status);
const stop = (watch: Watch<unknown> | null) => {
  if (!watch) return;
  watch.closed = true;
  const stream = watch.stream;
  watch.stream = null;
  if (stream) void stream.close().catch(() => {});
};
const DEFAULT_SIZE = { cols: 80, rows: 24 };

export function createTerminals(
  host: Host,
  options: {
    sessionId(): string | null;
    active(): boolean;
    open(entry: ResourceUpdate, model: TerminalModel): void;
  },
) {
  const entries = signal<TerminalRow[]>([]);
  const error = signal<unknown>('');
  const loading = signal(false);
  const starting = signal(false);
  const pending = signal<ClientOperation[]>([]);
  const recovering = signal(false);
  const known = signal(false);
  const models = new Map<string, TerminalModel>();
  let sessionId: string | null = null;
  let scope: ScopedHost | null = null;
  let alive = true;
  let watch: Watch<unknown> | null = null;
  let listGeneration = 0;
  const owns = (session: string) =>
    alive && options.sessionId() === session && sessionId === session;
  const refreshPending = async (session: string, owner: ScopedHost) => {
    const originals = await pendingTerminals(owner);
    if (owns(session) && scope === owner) {
      pending.set(originals);
      known.set(true);
    }
  };
  const mutate = async <M extends 'start' | 'stop' | 'control' | 'release'>(
    owner: ScopedHost,
    method: M,
    input: Parameters<typeof terminalMutation<M>>[2],
  ): ReturnType<typeof terminalMutation<M>> => {
    // Releases are cleanup of their immutable original, including after selection changes.
    if (
      method !== 'release' &&
      (!owns(owner.sessionId) || scope !== owner || !known() || pending().length)
    )
      throw new UiError('Recover the unresolved terminal action before sending new input.');
    try {
      return await terminalMutation(owner, method, input);
    } catch (reason) {
      if (owns(owner.sessionId) && scope === owner) {
        try {
          await refreshPending(owner.sessionId, owner);
        } catch (failure) {
          if (owns(owner.sessionId) && scope === owner) {
            known.set(false);
            error.set(failure);
          }
        }
      }
      throw reason;
    }
  };
  const accept = (resources: ResourceUpdate[]) => {
    // A fresh Host snapshot updates an existing terminal; it does not replace
    // the List's row owner while its original native control is being used.
    const previous = new Map(entries().map((row) => [row.value().result.ref, row]));
    entries.set(
      resources
        .filter((entry) => entry.sessionId === sessionId && entry.result.kind === 'shell_run')
        .sort(
          (a, b) =>
            a.result.startedAt - b.result.startedAt || a.result.ref.localeCompare(b.result.ref),
        )
        .map((entry) => {
          let row = previous.get(entry.result.ref);
          if (row) row.value.set(entry);
          else row = { value: signal(entry) };
          models.get(entry.result.ref)?.update(entry);
          return row;
        }),
    );
  };
  const follow = (session: string) => {
    stop(watch);
    const run: Watch<unknown> = { closed: false, stream: null };
    watch = run;
    const generation = ++listGeneration;
    const current = () =>
      owns(session) &&
      options.active() &&
      watch === run &&
      !run.closed &&
      generation === listGeneration;
    loading.set(true);
    error.set('');
    void (async () => {
      try {
        const opened = await host.subscribe('terminal', 'watchList', {
          sessionId: session,
          offset: 0,
        });
        if (!current()) {
          await opened.close();
          return;
        }
        run.stream = opened;
        for (;;) {
          const outcome = await opened.next();
          if (!current()) return;
          if (!outcome) throw new UiError('The Host closed the terminal list.');
          const page = completed(outcome);
          const resources = [...page.resources];
          for (let offset = page.nextOffset ?? null; offset !== null; ) {
            const more = completed(
              await host.query('terminal', 'list', { sessionId: session, offset }),
            );
            if (!current()) return;
            resources.push(...more.resources);
            offset = more.nextOffset ?? null;
          }
          accept(resources);
          loading.set(false);
        }
      } catch (reason) {
        if (current()) {
          error.set(reason);
          loading.set(false);
        }
      } finally {
        stop(run);
        if (watch === run) watch = null;
      }
    })();
  };
  const open = (target: TerminalTarget) => {
    if (!sessionId || !scope || !owns(target.sessionId)) return;
    const entry = entries()
      .find((row) => row.value().result.ref === target.ref)
      ?.value();
    if (!entry) return;
    let model = models.get(entry.result.ref);
    if (!model) {
      model = createTerminal(host, entry, scope, {
        admitted: () => owns(entry.sessionId) && known() && !pending().length,
        mutate,
        removed: () => models.delete(entry.result.ref),
      });
      models.set(entry.result.ref, model);
    }
    options.open(entry, model);
  };
  effect(() => {
    const selected = options.sessionId();
    untracked(() => {
      if (selected === sessionId) return;
      stop(watch);
      watch = null;
      for (const model of [...models.values()]) model.dispose();
      models.clear();
      sessionId = selected;
      scope = selected ? host.session(selected) : null;
      entries.set([]);
      error.set('');
      starting.set(false);
      recovering.set(false);
      pending.set([]);
      known.set(false);
      const owner = scope;
      if (selected && owner)
        void refreshPending(selected, owner).catch((reason) => {
          if (owns(selected) && scope === owner) error.set(reason);
        });
    });
  });
  effect(() => {
    const selected = options.sessionId();
    const visible = options.active();
    untracked(() => {
      if (selected && selected === sessionId && visible) {
        if (!watch) follow(selected);
      } else {
        stop(watch);
        watch = null;
      }
    });
  });
  const refresh = () => {
    if (!sessionId || !scope || !owns(sessionId)) return;
    const selected = sessionId;
    const owner = scope;
    void refreshPending(selected, owner).catch((reason) => {
      if (owns(selected) && scope === owner) error.set(reason);
    });
    if (options.active()) follow(selected);
  };
  const start = async () => {
    const selected = sessionId;
    const owner = scope;
    if (!selected || !owner || !owns(selected) || starting() || !known() || pending().length)
      return;
    starting.set(true);
    error.set('');
    try {
      const entry = completed(
        await mutate(owner, 'start', { sessionId: selected, size: DEFAULT_SIZE }),
      );
      if (!owns(selected) || scope !== owner) return;
      accept([
        ...entries()
          .map((row) => row.value())
          .filter((item) => item.result.ref !== entry.result.ref),
        entry,
      ]);
      open({ sessionId: entry.sessionId, ref: entry.result.ref });
    } catch (reason) {
      if (owns(selected) && scope === owner) error.set(reason);
    } finally {
      if (owns(selected) && scope === owner) starting.set(false);
    }
  };
  const recover = async (target: { sessionId: string; id: string; abandon: boolean }) => {
    const owner = scope;
    if (
      !owner ||
      !owns(target.sessionId) ||
      recovering() ||
      !pending().some((item) => item.id === target.id)
    )
      return;
    recovering.set(true);
    error.set('');
    try {
      if (target.abandon) await abandonTerminal(owner, target.id);
      else {
        const reply: OperationReply = await recoverTerminal(owner, target.id);
        if (reply.receipt.kind !== 'recorded' || reply.receipt.outcome.kind !== 'returned')
          throw new UiError('The original terminal result is still unknown. It was not repeated.');
      }
      await refreshPending(target.sessionId, owner);
      if (owns(target.sessionId) && scope === owner && options.active()) follow(target.sessionId);
    } catch (reason) {
      if (owns(target.sessionId) && scope === owner) error.set(reason);
    } finally {
      if (owns(target.sessionId) && scope === owner) recovering.set(false);
    }
  };
  cleanup(() => {
    alive = false;
    stop(watch);
    for (const model of [...models.values()]) model.dispose();
    models.clear();
  });
  return {
    entries,
    error: () => renderText(errorText(error())),
    loading,
    starting,
    pending,
    recovering,
    known,
    start,
    refresh,
    recover,
    open,
  };
}

function createTerminal(
  host: Host,
  initial: ResourceUpdate,
  scope: ScopedHost,
  hooks: {
    admitted(): boolean;
    mutate: typeof terminalMutation;
    removed(): void;
  },
) {
  const entry = signal(initial);
  const version = signal(0);
  const state = signal<'idle' | 'loading' | 'live' | 'closed' | 'unavailable' | 'failed'>('idle');
  const error = signal<unknown>('');
  const control = signal<'none' | 'acquiring' | 'held' | 'refused'>('none');
  const stopping = signal(false);
  const grid = new TerminalGrid(DEFAULT_SIZE);
  const target = { sessionId: initial.sessionId, ref: initial.result.ref };
  let alive = true;
  let active = false;
  let after = 0;
  let reading: Watch<unknown> | null = null;
  let observing: Watch<unknown> | null = null;
  let retained: Watch<unknown> | null = null;
  let lease: (Watch<unknown> & { id: string | null; next: number; held: boolean }) | null = null;
  let size: TerminalSize = DEFAULT_SIZE;
  let sentSize: TerminalSize | null = null;
  let queue: RawAction[] = [];
  let sending = false;
  const local = () => entry().ownership.kind === 'local';
  const agentOwned = () => entry().sourceTurnId !== entry().sourceToolCallId;
  const controllable = () =>
    alive &&
    active &&
    !stopping() &&
    hooks.admitted() &&
    local() &&
    running(entry()) &&
    entry().result.mode === 'pty' &&
    state() === 'live';
  const release = () => {
    queue = [];
    const previous = lease;
    lease = null;
    control.set('none');
    if (!previous) return;
    previous.closed = true;
    // Closing acquire itself revokes its native controller, including if release fails.
    void (async () => {
      try {
        if (previous.held && previous.id)
          completed(await hooks.mutate(scope, 'release', { target, controllerId: previous.id }));
      } catch (reason) {
        if (alive) error.set(reason);
      } finally {
        stop(previous);
      }
    })();
  };
  const fail = (reason: unknown) => {
    if (!alive || !active) return;
    error.set(reason);
    state.set('failed');
    release();
  };
  const snapshot = () => {
    if (!alive || !active || running(entry()) || retained) return;
    const run: Watch<unknown> = { closed: false, stream: null };
    retained = run;
    grid.discardDisplay();
    void (async () => {
      try {
        const opened = await host.subscribe('terminal', 'readDisplay', target);
        if (!alive || !active || retained !== run) {
          await opened.close();
          return;
        }
        run.stream = opened;
        let installed = false;
        for (;;) {
          const value = await opened.next();
          if (!alive || !active || run.closed || retained !== run) return;
          if (!value) break;
          installed = grid.displayPart(completed(value)) || installed;
        }
        await opened.close();
        run.stream = null;
        if (!alive || !active || run.closed || retained !== run) return;
        if (!installed) throw new UiError('The retained terminal display did not complete.');
        version.set(version() + 1);
        state.set('closed');
      } catch (reason) {
        if (!run.closed && alive && active) fail(reason);
      } finally {
        stop(run);
        if (retained === run) {
          grid.discardDisplay();
          retained = null;
        }
      }
    })();
  };
  const observe = () => {
    const run: Watch<unknown> = { closed: false, stream: null };
    observing = run;
    void (async () => {
      try {
        const opened = await host.subscribe('terminal', 'watch', target);
        if (!alive || !active || observing !== run) {
          await opened.close();
          return;
        }
        run.stream = opened;
        for (;;) {
          const value = await opened.next();
          if (!alive || !active || run.closed || observing !== run) return;
          if (!value) throw new UiError('The Host closed the terminal resource observation.');
          entry.set(completed(value));
          if (state() === 'unavailable' && !running(entry())) snapshot();
        }
      } catch (reason) {
        if (!run.closed && alive && active) fail(reason);
      } finally {
        stop(run);
        if (observing === run) observing = null;
      }
    })();
  };
  const follow = () => {
    if (!alive || !active || reading) return;
    if (entry().result.mode === 'pipes') {
      state.set('live');
      return;
    }
    if (state() === 'closed') return;
    if (state() === 'unavailable') {
      if (!observing) observe();
      snapshot();
      return;
    }
    const run: Watch<unknown> = { closed: false, stream: null };
    reading = run;
    state.set('loading');
    error.set('');
    void (async () => {
      try {
        const opened = await host.subscribe('terminal', 'watchOutput', { target, after });
        if (!alive || !active || reading !== run) {
          await opened.close();
          return;
        }
        run.stream = opened;
        for (;;) {
          const value = await opened.next();
          if (!alive || !active || run.closed || reading !== run) return;
          if (!value) throw new UiError('The Host closed output without an end marker.');
          const event = completed(value);
          const applied = grid.apply(event) as { after: number; status: string };
          after = applied.after;
          version.set(version() + 1);
          if (event.kind === 'unavailable') {
            state.set('unavailable');
            release();
            if (!observing) observe();
            snapshot();
            break;
          }
          state.set(event.kind === 'closed' ? 'closed' : 'live');
          if (event.kind === 'closed') {
            release();
            break;
          }
        }
      } catch (reason) {
        if (!run.closed && alive && active) fail(reason);
      } finally {
        stop(run);
        if (reading === run) reading = null;
      }
    })();
  };
  const wantedSize = () =>
    agentOwned() || (sentSize?.cols === size.cols && sentSize?.rows === size.rows) ? null : size;
  const pump = async () => {
    const owner = lease;
    if (sending || !owner || !owner.held || !owner.id) return;
    sending = true;
    try {
      while (lease === owner && !owner.closed && controllable()) {
        const resize = wantedSize();
        if (!queue.length && !resize) break;
        // These are the original Processes controller's 32 KiB / 64-action admission limits,
        // not limits on how much user input may wait for the serialized owner.
        const actions: RawAction[] = [];
        let bytes = 0;
        while (queue.length && actions.length < 64) {
          const action = queue[0]!;
          const length = 'text' in action ? new TextEncoder().encode(action.text).length + 12 : 32;
          if (actions.length && bytes + length > 32 * 1024) break;
          actions.push(queue.shift()!);
          bytes += length;
        }
        const receipt = completed(
          await hooks.mutate(scope, 'control', {
            controller: { target, controllerId: owner.id },
            sequence: owner.next,
            actions,
            ...(resize ? { size: resize } : {}),
          }),
        );
        if (lease !== owner || owner.closed) return;
        owner.next = receipt.sequence + 1;
        if (resize) sentSize = resize;
      }
    } catch (reason) {
      if (lease === owner && !owner.closed) {
        release();
        control.set('refused');
        error.set(reason);
      }
    } finally {
      sending = false;
      if (lease && lease !== owner && lease.held) void pump();
    }
  };
  const acquire = async () => {
    if (!controllable() || lease) return;
    const owner = {
      closed: false,
      stream: null as Stream<unknown> | null,
      id: null as string | null,
      next: 1,
      held: false,
    };
    lease = owner;
    control.set('acquiring');
    error.set('');
    try {
      const opened = await host.subscribe('terminal', 'acquire', target);
      if (lease !== owner || owner.closed || !controllable()) {
        await opened.close();
        return;
      }
      owner.stream = opened;
      for (;;) {
        const outcome = await opened.next();
        if (lease !== owner || owner.closed) return;
        if (!outcome) throw new UiError('Terminal input control was released by the Host.');
        const held = completed(outcome);
        if (!held.held || held.nextSequence == null)
          throw new UiError('Another controller owns this terminal.');
        owner.id = held.controllerId;
        owner.next = held.nextSequence;
        owner.held = true;
        sentSize = null;
        control.set('held');
        void pump();
      }
    } catch (reason) {
      if (lease === owner && !owner.closed) {
        release();
        control.set('refused');
        error.set(reason);
      }
    } finally {
      stop(owner);
      if (lease === owner) {
        lease = null;
        control.set('none');
      }
    }
  };
  const input = (actions: RawAction[]) => {
    if (!controllable()) return;
    if (control() === 'refused') return;
    if (!lease && actions.every((action) => action.type === 'mouse')) return;
    for (const action of actions) {
      if ('text' in action) {
        // At most three UTF-8 bytes per UTF-16 unit; leave the original control
        // framing room and never split a surrogate pair between native calls.
        for (let offset = 0; offset < action.text.length; ) {
          let end = Math.min(offset + 8 * 1024, action.text.length);
          const last = action.text.charCodeAt(end - 1);
          if (end < action.text.length && last >= 0xd800 && last <= 0xdbff) end--;
          queue.push({ ...action, text: action.text.slice(offset, end) });
          offset = end;
        }
      } else queue.push(action);
    }
    if (lease?.held) void pump();
    else if (!lease) void acquire();
  };
  const suspend = () => {
    active = false;
    stop(reading);
    reading = null;
    stop(observing);
    observing = null;
    stop(retained);
    retained = null;
    grid.discardDisplay();
    release();
  };
  const model = {
    target,
    entry,
    version,
    grid,
    state,
    error: () => renderText(errorText(error())),
    control,
    stopping,
    running: () => running(entry()),
    local,
    agentOwned,
    controllable,
    position: { x: 0, y: 0 },
    atBottom: true,
    update(value: ResourceUpdate) {
      if (alive && value.sessionId === target.sessionId && value.result.ref === target.ref) {
        entry.set(value);
        if (state() === 'unavailable' && !running(value)) snapshot();
      }
    },
    activate() {
      if (!alive || active) return;
      active = true;
      if (entry().result.mode === 'pipes') observe();
      follow();
    },
    suspend,
    input,
    resize(value: TerminalSize) {
      size = { cols: value.cols, rows: Math.min(value.rows, Math.floor(65536 / value.cols)) };
      if (lease?.held) void pump();
    },
    takeControl() {
      if (control() === 'refused') control.set('none');
      void acquire();
    },
    release,
    retry() {
      if (alive && active) {
        if (state() === 'failed') {
          stop(reading);
          reading = null;
          stop(retained);
          retained = null;
          grid.reset(DEFAULT_SIZE);
          after = 0;
          state.set('idle');
          if (entry().result.mode === 'pipes' && !observing) observe();
          follow();
        } else model.takeControl();
      }
    },
    async stop() {
      if (!alive || !active || !hooks.admitted() || !local() || !running(entry()) || stopping())
        return;
      stopping.set(true);
      try {
        entry.set(completed(await hooks.mutate(scope, 'stop', target)).resource);
        release();
      } catch (reason) {
        if (alive) {
          error.set(reason);
          release();
        }
      } finally {
        if (alive) stopping.set(false);
      }
    },
    dispose() {
      if (!alive) return;
      alive = false;
      suspend();
      hooks.removed();
    },
  };
  return model;
}
export type TerminalModel = ReturnType<typeof createTerminal>;
export type TerminalsModel = ReturnType<typeof createTerminals>;
