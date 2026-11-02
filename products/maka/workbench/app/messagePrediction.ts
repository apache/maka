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
type Suggestion = NonNullable<ReturnType<ComposerPrediction['current']>>;
type Result = { sourceTurnId: string; policyRevision: number; suggestion: string | null };
type Source = { turnId: string; trigger: Trigger; contextKey: string };
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

let preferences: { revision: number; value: SettingsAssistantPreferences | null } | null = null;
const observers = new Set<() => void>();

/** Share observed settings, so a saved change immediately retires old suggestions. */
export function observePredictionPreferences(value: SettingsAssistantPreferences): void {
  if (preferences && value.revision < preferences.revision) return;
  if (preferences?.value === value) return;
  preferences = { revision: value.revision, value };
  for (const observe of observers) observe();
}

export function invalidatePredictionPreferences(revision: number): void {
  if (preferences && revision < preferences.revision) return;
  preferences = { revision, value: null };
  for (const observe of observers) observe();
}

/** One resident conversation retains only its current source and its original request. */
export function createMessagePrediction(options: Options) {
  let alive = true;
  let eligible = false;
  let source: Source | null = null;
  let dismissed = false;
  let shown: Suggestion | null = null;
  let settled: { source: Source; revision: number; value: Suggestion | null } | null = null;
  let request: Request | null = null;
  let reading: { source: Source; stale: boolean } | null = null;
  let settingsReady = false;

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
  const owns = (ticket: Request) =>
    alive &&
    eligible &&
    !dismissed &&
    !ticket.cancelled &&
    source === ticket.source &&
    preferences?.revision === ticket.revision &&
    preferences.value?.predictions.enabled === true;

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
        settled = {
          source: ticket.source,
          revision: ticket.revision,
          value:
            result.suggestion === null
              ? null
              : { sourceTurnId: result.sourceTurnId, text: result.suggestion },
        };
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
          (settled?.source !== ticket.source || settled.revision !== ticket.revision)
        )
          settled = { source: ticket.source, revision: ticket.revision, value: null };
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
          settingsReady = value.revision >= (preferences?.revision ?? -1);
          ticket.stale = !settingsReady;
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
    if (!eligible || !source || dismissed) {
      publish(null);
      cancel();
      return;
    }
    const config = preferences?.value;
    if (!settingsReady || !config) {
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
    if (settled?.source === source && settled.revision === config.revision) {
      publish(settled.value);
      return;
    }
    publish(null);
    if (request) {
      if (request.source !== source || request.revision !== config.revision) cancel();
      return;
    }
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
    if (!preferences?.value) settingsReady = false;
    refresh();
  };
  observers.add(changedPreferences);
  const presentation: ComposerPrediction = {
    current: () => shown,
    dismiss(sourceTurnId) {
      if (source?.turnId !== sourceTurnId) return;
      dismissed = true;
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
      source = turnId === null ? null : { turnId, trigger, contextKey };
      dismissed = false;
      settled = null;
      settingsReady = false;
      refresh();
    },
    eligible(value: boolean) {
      if (!alive || eligible === value) return;
      eligible = value;
      if (!value) settingsReady = false;
      refresh();
    },
    dispose() {
      if (!alive) return;
      cancel();
      observers.delete(changedPreferences);
      alive = false;
      shown = null;
    },
  };
}
