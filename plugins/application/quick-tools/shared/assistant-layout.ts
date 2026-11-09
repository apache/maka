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

/** Keep turns in chronological order and omit internal process rows. */
export function quickAssistantOrder(
  entries: readonly {
    key: string;
    turn?: string;
    kind: string;
    role?: string;
  }[],
): string[] {
  const turns = new Map<string, string[]>();
  for (const entry of entries) {
    if (
      !['bot', 'botWorking', 'botWaiting', 'botNote'].includes(entry.kind) &&
      entry.role !== 'user'
    )
      continue;
    const key = entry.turn ?? 'latest';
    const group = turns.get(key) ?? [];
    group.push(entry.key);
    turns.set(key, group);
  }
  return [...turns.values()].flat();
}
