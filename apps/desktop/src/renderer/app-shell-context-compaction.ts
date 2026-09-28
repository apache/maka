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

import type { ContextCompactionOutcome } from '@maka/core/events';
import type { UiLocale } from '@maka/core/ui-locale';
import type { ContextCompactResult } from '@maka/runtime-host/protocol';
import { getShellCopy } from './locales/shell-copy.js';

const SETTLED_PRESENTATION_LIMIT = 128;

export interface ContextCompactionNotice {
  level: 'success' | 'info' | 'error';
  title: string;
  description: string;
}

export function contextCompactionNotice(
  outcome: ContextCompactionOutcome,
  uiLocale: UiLocale,
): ContextCompactionNotice {
  const copy = getShellCopy(uiLocale).app;
  if (outcome.kind === 'compacted') {
    return {
      level: 'success',
      title: copy.compactSuccessTitle,
      description: copy.compactSuccessDescription,
    };
  }
  if (outcome.kind === 'unchanged') {
    return {
      level: 'info',
      title: copy.compactUnchangedTitle,
      description: copy.compactUnchangedDescription,
    };
  }
  return {
    level: 'error',
    title: copy.compactErrorTitle,
    description: copy.compactErrorFallback,
  };
}

export function createContextCompactionPresentation(options: {
  toastApi: {
    toast(input: {
      title: string;
      description?: string;
      variant?: 'info';
      duration?: number;
    }): string;
    dismiss(id: string): void;
  };
  presentTerminal(sessionId: string, notice: ContextCompactionNotice): void;
}) {
  const runningToastByTurn = new Map<string, string>();
  const settledTurns = new Set<string>();
  const settledTurnOrder: string[] = [];

  return {
    started(sessionId: string, turnId: string, uiLocale: UiLocale): void {
      const key = compactionKey(sessionId, turnId);
      if (runningToastByTurn.has(key) || settledTurns.has(key)) return;
      const copy = getShellCopy(uiLocale).app;
      runningToastByTurn.set(
        key,
        options.toastApi.toast({
          title: copy.compactStartedTitle,
          description: copy.compactStartedDescription,
          variant: 'info',
          duration: 0,
        }),
      );
    },

    finished(
      sessionId: string,
      turnId: string,
      outcome: ContextCompactionOutcome,
      uiLocale: UiLocale,
    ): void {
      const key = compactionKey(sessionId, turnId);
      if (settledTurns.has(key)) return;
      settledTurns.add(key);
      settledTurnOrder.push(key);
      if (settledTurnOrder.length > SETTLED_PRESENTATION_LIMIT) {
        settledTurns.delete(settledTurnOrder.shift()!);
      }
      const runningToastId = runningToastByTurn.get(key);
      if (runningToastId) options.toastApi.dismiss(runningToastId);
      runningToastByTurn.delete(key);
      options.presentTerminal(sessionId, contextCompactionNotice(outcome, uiLocale));
    },
  };
}

export type ContextCompactionPresentation = ReturnType<typeof createContextCompactionPresentation>;

export function presentContextCompactionResult(
  presentation: ContextCompactionPresentation,
  sessionId: string,
  result: ContextCompactResult,
  uiLocale: UiLocale,
): boolean {
  if (result.kind === 'started') {
    presentation.started(sessionId, result.turn.turnId, uiLocale);
    return true;
  }
  presentation.finished(sessionId, result.turn.turnId, result.outcome, uiLocale);
  return result.outcome.kind !== 'failed';
}

function compactionKey(sessionId: string, turnId: string): string {
  return `${sessionId}\u0000${turnId}`;
}
