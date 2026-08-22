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

export type CompanionForkVisibilityEvent =
  | { type: 'fork-created'; sessionId: string }
  | { type: 'cleanup-succeeded'; sessionId: string };

/**
 * The renderer owns transient companion visibility, while the main process owns
 * deletion. Keep every created fork hidden until that authority confirms cleanup
 * or a later authoritative session list no longer contains it.
 */
export function applyCompanionForkVisibilityEvent(
  current: ReadonlySet<string>,
  event: CompanionForkVisibilityEvent,
): ReadonlySet<string> {
  if (event.type === 'fork-created') {
    if (current.has(event.sessionId)) return current;
    return new Set([...current, event.sessionId]);
  }
  if (!current.has(event.sessionId)) return current;
  const next = new Set(current);
  next.delete(event.sessionId);
  return next;
}

export function reconcileCompanionForkVisibility(
  current: ReadonlySet<string>,
  authoritativeSessionIds: ReadonlySet<string>,
): ReadonlySet<string> {
  if (current.size === 0) return current;
  const next = new Set([...current].filter((id) => authoritativeSessionIds.has(id)));
  return next.size === current.size ? current : next;
}
