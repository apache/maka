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

import type { SessionEvent } from '@maka/core/events';
import type { StoredMessage } from '@maka/core/session';
import type { UiLocale } from '@maka/core/ui-locale';
import { applyLiveTurnEvent, reconcileTerminalLiveTurn, settleLiveTurnStep, type LiveTurnProjection } from './live-turn-projection.js';

/** Unsettled presentation evidence, indexed by Turn identity rather than execution recency. */
export type LiveTurnBuffer = readonly LiveTurnProjection[];

export function retainLiveTurn(buffer: LiveTurnBuffer | undefined, turn: LiveTurnProjection): LiveTurnBuffer {
  return buffer?.some((previous) => previous.turnId === turn.turnId) ? buffer : [...(buffer ?? []), turn];
}

export function applyLiveTurnBufferEvent(buffer: LiveTurnBuffer | undefined, event: SessionEvent, locale: UiLocale): LiveTurnBuffer | undefined {
  const previous = buffer?.find((turn) => turn.turnId === event.turnId);
  const next = applyLiveTurnEvent(previous, event, locale);
  if (next === previous) return buffer;
  if (!previous) return next ? [...(buffer ?? []), next] : buffer;
  const turns = buffer!.flatMap((turn) => turn !== previous ? [turn] : next ? [next] : []);
  return turns.length ? turns : undefined;
}

function mapBuffer(buffer: LiveTurnBuffer, update: (turn: LiveTurnProjection) => LiveTurnProjection | undefined): LiveTurnBuffer | undefined {
  const turns = buffer.flatMap((turn) => { const next = update(turn); return next ? [next] : []; });
  if (turns.length === buffer.length && turns.every((turn, index) => turn === buffer[index])) return buffer;
  return turns.length ? turns : undefined;
}

export function settleLiveTurnBufferStep(buffer: LiveTurnBuffer, stepId: string): LiveTurnBuffer | undefined {
  return mapBuffer(buffer, (turn) => settleLiveTurnStep(turn, stepId));
}

export function reconcileLiveTurnBuffer(buffer: LiveTurnBuffer, messages: readonly StoredMessage[]): LiveTurnBuffer | undefined {
  return mapBuffer(buffer, (turn) => {
    let retained = reconcileTerminalLiveTurn(turn, messages);
    // A terminal Turn has no future reveal work. Its durable answer can finish
    // the handoff even after the original callback or refresh attempt was lost.
    if (retained?.terminal) {
      for (const message of messages) {
        if (!retained) break;
        if (message.type === 'assistant' && message.turnId === turn.turnId) {
          retained = settleLiveTurnStep(retained, message.id);
        }
      }
    }
    return retained;
  });
}
