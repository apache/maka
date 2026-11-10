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

import type { SettingsAssistantPreferences } from '../../../../packages/plugin-sdk/src/index.js';
import type { ComposerPrediction } from '../../../../packages/plugin-sdk/src/composer-view.js';
import type { OriginalMutation } from './host';

type Trigger = 'live' | 'catch_up';
type ComposerState = 'restoring' | 'occupied' | 'empty';
type Suggestion = NonNullable<ReturnType<ComposerPrediction['current']>>;
type Result = { sourceTurnId: string; policyRevision: number; suggestion: string | null };
type Source = {
  readonly turnId: string;
  readonly trigger: Trigger;
  readonly contextKey: string;
  settingsReady: boolean;
  state:
    | { kind: 'unsettled' }
    | { kind: 'settled'; revision: number; value: Suggestion | null }
    | { kind: 'skipped' }
    | { kind: 'dismissed' };
};
export function predictionTrigger(input: {
  completedTurnId: string | null;
  activeTurnId: string | null;
  previousActiveTurnId: string | null;
  completedEventTurnId: string | null;
}): Trigger {
  return input.completedTurnId !== null &&
    input.activeTurnId === null &&
    (input.completedTurnId === input.previousActiveTurnId ||
      input.completedTurnId === input.completedEventTurnId)
    ? 'live'
    : 'catch_up';
}

type Options = {
  sessionId: string;
  preferences(): Promise<SettingsAssistantPreferences>;
  begin(input: {
    sessionId: string;
    expectedTurnId: string;
    trigger: Trigger;
  }): Promise<OriginalMutation>;
  changed(value: Suggestion | null): void;
  report(reason: unknown): void;
};
type Request = {
  source: Source;
  revision: number;
  cancelled: boolean;
  operation: OriginalMutation | null;
};

type PreferencesState =
  | { kind: 'unknown' }
  | { kind: 'invalidated'; revision: number }
  | { kind: 'ready'; value: SettingsAssistantPreferences };

function createPreferencesOwner() {
  let state: PreferencesState = { kind: 'unknown' };
  const observers = new Set<() => void>();
  const revision = () =>
    state.kind === 'unknown'
      ? null
      : state.kind === 'invalidated'
        ? state.revision
        : state.value.revision;
  const changed = () => {
    for (const observe of observers) observe();
  };
  return {
    revision,
    value: () => (state.kind === 'ready' ? state.value : null),
    observe(value: SettingsAssistantPreferences) {
      const previous = revision();
      if (previous !== null && value.revision < previous) return;
      if (state.kind === 'ready' && state.value === value) return;
      state = { kind: 'ready', value };
      changed();
    },
    invalidate(next: number) {
      const previous = revision();
      if (previous !== null && next < previous) return;
      state = { kind: 'invalidated', revision: next };
      changed();
    },
    subscribe(observe: () => void) {
      observers.add(observe);
      return () => observers.delete(observe);
    },
  };
}

// Settings and conversations are separate bundles in the same window VM.
const OWNER = Symbol.for('maka.prediction-preferences');
const shared = globalThis as { [OWNER]?: ReturnType<typeof createPreferencesOwner> };
const preferences = (shared[OWNER] ??= createPreferencesOwner());

/** Share observed settings, so a saved change immediately retires old suggestions. */
export function observePredictionPreferences(value: SettingsAssistantPreferences): void {
  preferences.observe(value);
}

export function invalidatePredictionPreferences(revision: number): void {
  preferences.invalidate(revision);
}

/** One resident conversation retains only its current source and its original request. */
export function createMessagePrediction(options: Options) {
  let alive = true;
  let eligible = false;
  let composer: ComposerState = 'restoring';
  let source: Source | null = null;
  let shown: Suggestion | null = null;
  let request: Request | null = null;
  let reading: { source: Source; stale: boolean } | null = null;

  const publish = (value: Suggestion | null) => {
    if (!alive || shown === value) return;
    shown = value;
    options.changed(value);
  };
  const cancel = () => {
    if (request && !request.cancelled) {
      request.cancelled = true;
      request.operation?.cancel();
    }
  };
  const owns = (ticket: Request) => {
    const config = preferences.value();
    return (
      alive &&
      eligible &&
      ticket.source.state.kind !== 'dismissed' &&
      !ticket.cancelled &&
      source === ticket.source &&
      config?.revision === ticket.revision &&
      config.predictions.enabled === true
    );
  };

  const generate = async (ticket: Request) => {
    try {
      if (!owns(ticket)) return;
      const original = await options.begin({
        sessionId: options.sessionId,
        expectedTurnId: ticket.source.turnId,
        trigger: ticket.source.trigger,
      });
      ticket.operation = original;
      if (!owns(ticket)) {
        ticket.cancelled = true;
        original.cancel();
      }
      // Drain the original operation before replacing this conversation's request.
      for (;;) {
        const event = await original.next();
        if (event === null) throw new Error('Message prediction ended before its receipt.');
        if (event.kind === 'not_dispatched') return;
        if (event.kind !== 'finished') continue;
        if (event.cleanupError) options.report(new Error(event.cleanupError));
        if (!owns(ticket)) return;
        const receipt = event.reply.receipt;
        if (receipt.kind !== 'recorded' || receipt.outcome.kind !== 'returned')
          throw new Error('Message prediction did not return a result.');
        const result = receipt.outcome.value as Result;
        if (
          result.sourceTurnId !== ticket.source.turnId ||
          result.policyRevision !== ticket.revision
        )
          return;
        const settled = {
          kind: 'settled' as const,
          revision: ticket.revision,
          value:
            result.suggestion === null
              ? null
              : { sourceTurnId: result.sourceTurnId, text: result.suggestion },
        };
        ticket.source.state = settled;
        publish(settled.value);
        return;
      }
    } catch (reason) {
      if (!ticket.cancelled) options.report(reason);
    } finally {
      if (request === ticket) {
        if (
          !ticket.cancelled &&
          source === ticket.source &&
          (ticket.source.state.kind !== 'settled' ||
            ticket.source.state.revision !== ticket.revision)
        )
          ticket.source.state = { kind: 'settled', revision: ticket.revision, value: null };
        request = null;
        refresh();
      }
    }
  };

  const readPreferences = () => {
    if (reading || !source || !alive || !eligible) return;
    const ticket = { source, stale: false };
    reading = ticket;
    void options
      .preferences()
      .then(
        (value) => {
          if (!alive || source !== ticket.source) return;
          const revision = preferences.revision();
          ticket.source.settingsReady = revision === null || value.revision >= revision;
          ticket.stale = !ticket.source.settingsReady;
          observePredictionPreferences(value);
          refresh();
        },
        (reason) => {
          if (alive && source === ticket.source) options.report(reason);
        },
      )
      .finally(() => {
        if (reading === ticket) {
          reading = null;
          if (alive && (source !== ticket.source || ticket.stale)) refresh();
        }
      });
  };

  function refresh() {
    if (!alive) return;
    if (
      source &&
      composer === 'occupied' &&
      (request?.source !== source || request.cancelled) &&
      (source.state.kind === 'unsettled' ||
        (source.state.kind === 'settled' &&
          preferences.revision() !== null &&
          source.state.revision !== preferences.revision()))
    )
      source.state = { kind: 'skipped' };
    if (
      !eligible ||
      !source ||
      source.state.kind === 'dismissed' ||
      source.state.kind === 'skipped'
    ) {
      publish(null);
      cancel();
      return;
    }
    const config = preferences.value();
    if (!source.settingsReady || !config) {
      publish(null);
      cancel();
      readPreferences();
      return;
    }
    if (!config.predictions.enabled) {
      publish(null);
      cancel();
      return;
    }
    if (source.state.kind === 'settled' && source.state.revision === config.revision) {
      publish(source.state.value);
      return;
    }
    publish(null);
    if (request) {
      if (request.source !== source || request.revision !== config.revision) cancel();
      return;
    }
    if (composer !== 'empty') return;
    const ticket: Request = {
      source,
      revision: config.revision,
      cancelled: false,
      operation: null,
    };
    request = ticket;
    void generate(ticket);
  }

  const changedPreferences = () => {
    if (source && !preferences.value()) source.settingsReady = false;
    refresh();
  };
  const unsubscribe = preferences.subscribe(changedPreferences);
  const presentation: ComposerPrediction = {
    current: () => shown,
    dismiss(sourceTurnId) {
      if (source?.turnId !== sourceTurnId) return;
      source.state = { kind: 'dismissed' };
      refresh();
    },
  };
  return {
    presentation,
    source(turnId: string | null, trigger: Trigger, contextKey = '') {
      if (
        !alive ||
        ((source?.turnId ?? null) === turnId &&
          (source === null || source.contextKey === contextKey))
      )
        return;
      source =
        turnId === null
          ? null
          : { turnId, trigger, contextKey, settingsReady: false, state: { kind: 'unsettled' } };
      refresh();
    },
    eligible(value: boolean, nextComposer: ComposerState) {
      if (!alive || (eligible === value && composer === nextComposer)) return;
      eligible = value;
      composer = nextComposer;
      if (!value && source) source.settingsReady = false;
      refresh();
    },
    dispose() {
      if (!alive) return;
      cancel();
      unsubscribe();
      alive = false;
      shown = null;
    },
  };
}
