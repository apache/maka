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

import type { ShellRunUpdate } from '@maka/core/events';
import type { StoredMessage } from '@maka/core/session';
import type { LiveTurnProjection } from './live-turn-projection.js';
import {
  applyShellRunOverlayEntry,
  foldShellRunUpdates,
  materializeTurns,
  overlayLiveTurn,
  projectTurnTools,
  type ShellRunOverlayEntry,
  type ToolActivityItem,
  type TurnViewModel,
} from './materialize.js';

/**
 * Incremental transcript projection (issue #2030).
 *
 * The runtime event stream is already incremental — every delta names the turn
 * it belongs to — but flattening it into a `messages` snapshot throws that away,
 * and the old composition tried to guess it back downstream with `memo`'s
 * reference comparison over three chained pure derivations. Two of those
 * derivations were not idempotent, so the guess was wrong on every token for
 * any session with background-command history.
 *
 * This layer owns the derived state instead of re-deriving it: it remembers the
 * settled turns and hands the previous object back for any turn a message
 * refresh did not actually change, so "what changed" is decided by value here
 * rather than guessed downstream from reference equality.
 *
 * Contract (mirrors `parseMarkdownIncremental`'s in `@astryxdesign/core`):
 * a turn keeps its object identity unless its projected value changed, and
 * projecting the same inputs twice returns the same result array, so calling
 * this during render stays safe under double-invocation.
 */
export interface TranscriptProjectionInput {
  /**
   * Releases the owned state when it changes, so one session's turns and tools
   * are not retained behind another's. Hygiene, not correctness: a switch that
   * kept the state would still project the new session correctly, because a
   * turn is only reused when its value matches.
   */
  sessionId?: string;
  messages: readonly StoredMessage[];
  liveTurn?: LiveTurnProjection;
  shellRunUpdates?: readonly ShellRunUpdate[];
}

export interface TranscriptProjection {
  project(input: TranscriptProjectionInput): readonly TurnViewModel[];
}

const NO_UPDATES: readonly ShellRunUpdate[] = [];
const NO_TURNS: readonly TurnViewModel[] = [];

export function createTranscriptProjection(): TranscriptProjection {
  let sessionId: string | undefined;
  let hasProjected = false;

  // Stage inputs, remembered so a stage only reruns when its own input moved.
  let lastMessages: readonly StoredMessage[] | undefined;
  let lastLiveTurn: LiveTurnProjection | undefined;
  let lastUpdates: readonly ShellRunUpdate[] | undefined;

  // Stage outputs.
  let settledTurns: readonly TurnViewModel[] = NO_TURNS;
  let liveTurns: readonly TurnViewModel[] = NO_TURNS;
  // Tracked separately from `lastMessages` because a refresh can leave the
  // settled projection untouched, which must not force the live overlay to run.
  let liveTurnsFrom: readonly TurnViewModel[] | undefined;
  let overlayEntries: ReadonlyMap<string, ShellRunOverlayEntry> = new Map();
  let lastTurns: readonly TurnViewModel[] = NO_TURNS;

  function reset(): void {
    hasProjected = false;
    lastMessages = undefined;
    lastLiveTurn = undefined;
    lastUpdates = undefined;
    settledTurns = NO_TURNS;
    liveTurns = NO_TURNS;
    liveTurnsFrom = undefined;
    overlayEntries = new Map();
    lastTurns = NO_TURNS;
  }

  function project(input: TranscriptProjectionInput): readonly TurnViewModel[] {
    if (hasProjected && input.sessionId !== sessionId) reset();
    sessionId = input.sessionId;
    const updates = input.shellRunUpdates ?? NO_UPDATES;
    // Compared element-wise against a copy we own, not by array identity: the
    // store publishes a new ShellRunUpdate object for every change it accepts,
    // so this holds even if a caller hands us the same array again after
    // mutating it in place.
    const updatesMoved = lastUpdates === undefined
      || lastUpdates.length !== updates.length
      || updates.some((update, index) => update !== lastUpdates![index]);

    // Same inputs, same answer, without advancing any owned state — which is
    // what makes projecting during render safe under double invocation.
    if (
      hasProjected
      && input.messages === lastMessages
      && input.liveTurn === lastLiveTurn
      && !updatesMoved
    ) {
      return lastTurns;
    }

    if (input.messages !== lastMessages) {
      settledTurns = reconcileTurnIdentities(settledTurns, materializeTurns(input.messages));
      lastMessages = input.messages;
    }
    if (liveTurnsFrom !== settledTurns || input.liveTurn !== lastLiveTurn) {
      liveTurns = overlayLiveTurn(settledTurns, input.liveTurn);
      liveTurnsFrom = settledTurns;
      lastLiveTurn = input.liveTurn;
    }
    if (updatesMoved) {
      overlayEntries = foldShellRunUpdates(updates);
      lastUpdates = [...updates];
    }

    // Final identity reconciliation against what we last published: a stage
    // that rewrote a turn without changing its value hands the previous object
    // back, so identity moves only when the value did.
    const overlaid = applyShellRunOverlay(liveTurns);
    lastTurns = hasProjected ? reconcileTurnIdentities(lastTurns, overlaid) : overlaid;
    hasProjected = true;
    return lastTurns;
  }

  /**
   * Apply the folded shell-run updates to the turns' canonical tools.
   *
   * A durable revision that permanently leads the persisted `tool_result`
   * snapshot makes `applyShellRunOverlayEntry` allocate a fresh tool every
   * time, so this pass cannot preserve identity on its own — the final
   * `reconcileTurnIdentities` above is what hands the previous turn back.
   */
  function applyShellRunOverlay(turns: readonly TurnViewModel[]): readonly TurnViewModel[] {
    if (overlayEntries.size === 0) return turns;
    // Scoped per turn: only a turn that actually holds an overlaid tool is
    // rebuilt, so the reconciliation above has a smaller set to walk.
    let anyTurnMoved = false;
    const overlaid = turns.map((turn) => {
      let turnMoved = false;
      const projected: ToolActivityItem[] = [];
      for (const tool of turn.tools) {
        const entry = overlayEntries.get(tool.toolUseId);
        const out = entry ? applyShellRunOverlayEntry(tool, entry) : tool;
        if (out !== tool) turnMoved = true;
        projected.push(out);
      }
      if (!turnMoved) return turn;
      anyTurnMoved = true;
      return projectTurnTools([turn], projected)[0]!;
    });
    return anyTurnMoved ? overlaid : turns;
  }

  return { project };
}

/**
 * Keep the previous object for every turn whose projected value is unchanged.
 * A message refresh rebuilds the whole snapshot from freshly deserialized IPC
 * rows, so nothing upstream can carry identity — the equality check here is
 * what narrows a refresh to the turns whose messages actually changed.
 */
export function reconcileTurnIdentities(
  previous: readonly TurnViewModel[],
  next: readonly TurnViewModel[],
): readonly TurnViewModel[] {
  if (previous.length === 0) return next;
  const previousById = new Map(previous.map((turn) => [turn.turnId, turn]));
  const reconciled = next.map((turn) => {
    const prior = previousById.get(turn.turnId);
    return prior && valuesEqual(prior, turn) ? prior : turn;
  });
  return reconciled.length === previous.length && reconciled.every((turn, index) => turn === previous[index])
    ? previous
    : reconciled;
}

/**
 * Structural equality over projected view data. Everything a turn holds is
 * plain JSON-shaped data (`args` and tool results included), so a value walk is
 * the whole comparison — with an identity short circuit that makes the common
 * "only the tail turn moved" case cheap.
 *
 * Fail-closed outside that shape: anything that is not a plain object or an
 * array (a Set, a Map, a Date, a class instance) compares unequal unless it is
 * the same reference, because walking its own enumerable keys would silently
 * call two different values equal. Reporting "changed" costs a re-render;
 * reporting "unchanged" freezes the UI on a stale value.
 *
 * This is the sole judge of whether a turn keeps its object identity, and that
 * identity is load-bearing beyond this module: the shell caches each turn's
 * derived presentation in a `WeakMap` keyed on the turn object itself. Relaxing
 * this comparison — skipping a field to save a walk — therefore fails twice
 * over: the changed turn keeps its identity AND hits a stale presentation
 * entry, and the UI freezes on the old value instead of merely re-rendering.
 */
export function valuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, index) => valuesEqual(item, b[index]));
  }
  if (!isPlainObject(a) || !isPlainObject(b)) return false;
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) {
    if (!valuesEqual(left[key], right[key])) return false;
  }
  return true;
}

function isPlainObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
