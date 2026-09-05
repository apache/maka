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

export interface ChatConversationItem<T> {
  readonly afterTurnId: string;
  readonly renderWhenAnchorMissing?: boolean;
  readonly value: T;
}

export function placeChatConversationItems<T>(
  items: readonly ChatConversationItem<T>[],
  residentTurnIds: ReadonlySet<string>,
): { byTurn: ReadonlyMap<string, readonly T[]>; orphan: T | undefined } {
  const byTurn = new Map<string, T[]>();
  let orphan: T | undefined;
  for (const item of items) {
    if (residentTurnIds.has(item.afterTurnId)) {
      const current = byTurn.get(item.afterTurnId) ?? [];
      current.push(item.value);
      byTurn.set(item.afterTurnId, current);
    } else if (item.renderWhenAnchorMissing) {
      orphan = item.value;
    }
  }
  return { byTurn, orphan };
}
