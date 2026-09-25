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

import type { StoredMessage } from '@maka/core/session';
import type { UiLocale } from '@maka/core/ui-locale';
import { materializeTurns, type TurnViewModel } from './materialize.js';

/**
 * Index immutable message snapshots before deriving view data. An append only
 * rebuilds the changed turns and their tool dependencies; replacement, prepend
 * and locale changes use the complete materializer. The caller reconciles the
 * returned candidates by value and supplies those settled turns on the next call.
 *
 * Tool results can belong to another turn than their call, and ShellRun child
 * results update the Bash in an earlier turn. Materialize their whole connected
 * group in storage order so the existing session-wide folding remains the sole
 * authority, including children preceding their parent and repeated results.
 */
export function createIncrementalTurnMaterializer() {
  let lastMessages: readonly StoredMessage[] | undefined;
  let lastLocale: UiLocale | undefined;
  const indicesByTurn = new Map<string, number[]>();
  const turnsByToolUseId = new Map<string, Set<string>>();
  const turnsByShellRun = new Map<string, Set<string>>();
  const dependenciesByTurn = new Map<string, Set<Set<string>>>();

  function link(index: Map<string, Set<string>>, key: string, turnId: string): void {
    let peers = index.get(key);
    if (!peers) {
      peers = new Set();
      index.set(key, peers);
    }
    peers.add(turnId);
    let dependencies = dependenciesByTurn.get(turnId);
    if (!dependencies) {
      dependencies = new Set();
      dependenciesByTurn.set(turnId, dependencies);
    }
    dependencies.add(peers);
  }

  function materialize(
    messages: readonly StoredMessage[],
    locale: UiLocale,
    previous: readonly TurnViewModel[],
  ): readonly TurnViewModel[] {
    const appended = lastMessages !== undefined
      && lastLocale === locale
      && extendsSnapshot(lastMessages, messages);
    const from = appended ? lastMessages!.length : 0;
    // A failed materialization must not leave a partially advanced index for
    // the next call to append to. A retry will rebuild from its input snapshot.
    lastMessages = undefined;
    if (!appended) {
      indicesByTurn.clear();
      turnsByToolUseId.clear();
      turnsByShellRun.clear();
      dependenciesByTurn.clear();
    }

    const affected = new Set<string>();
    const added = new Set<string>();
    const length = messages.length;
    for (let index = from; index < length; index += 1) {
      const message = messages[index]!;
      const turnId = message.turnId ?? '__loose';
      let indices = indicesByTurn.get(turnId);
      if (!indices) {
        indices = [];
        indicesByTurn.set(turnId, indices);
        added.add(turnId);
      }
      indices.push(index);
      affected.add(turnId);
      if (message.type === 'tool_call') {
        link(turnsByToolUseId, message.id, turnId);
      } else if (message.type === 'tool_result') {
        link(turnsByToolUseId, message.toolUseId, turnId);
        if (message.content.kind === 'shell_run') {
          link(turnsByShellRun, message.content.ref, turnId);
        }
      }
    }

    let result: readonly TurnViewModel[];
    if (!appended) {
      result = materializeTurns(messages, locale);
    } else if (affected.size === 0) {
      result = previous;
    } else {
      // Visit each shared dependency once, even when many turns refer to the
      // same background command. Set iteration also visits newly added turns.
      const visited = new Set<Set<string>>();
      for (const turnId of affected) {
        for (const peers of dependenciesByTurn.get(turnId) ?? []) {
          if (visited.has(peers)) continue;
          visited.add(peers);
          for (const peer of peers) affected.add(peer);
        }
      }
      const indices: number[] = [];
      for (const turnId of affected) {
        for (const index of indicesByTurn.get(turnId)!) indices.push(index);
      }
      indices.sort((left, right) => left - right);
      const changed = new Map(materializeTurns(
        indices.map((index) => messages[index]!),
        locale,
      ).map((turn) => [turn.turnId, turn]));
      const next = previous.map((turn) => changed.get(turn.turnId) ?? turn);
      for (const turnId of added) next.push(changed.get(turnId)!);
      result = next;
    }
    lastMessages = messages;
    lastLocale = locale;
    return result;
  }

  return { materialize };
}

function extendsSnapshot(
  previous: readonly StoredMessage[],
  next: readonly StoredMessage[],
): boolean {
  const length = previous.length;
  if (next.length < length) return false;
  for (let index = 0; index < length; index += 1) {
    if (previous[index] !== next[index]) return false;
  }
  return true;
}
