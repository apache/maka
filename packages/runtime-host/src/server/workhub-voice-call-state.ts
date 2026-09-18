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

import { resolve } from 'node:path';

// Live call lifecycle only: do not revive old calls from persisted interaction history.
const calls = new Map<string, Map<string, boolean>>();
export function recordWorkHubVoiceCall(path: string, callId: string, kind: string): void {
  if (kind !== 'call_started' && kind !== 'call_closed') return;
  const key = resolve(path);
  let scoped = calls.get(key);
  if (!scoped) {
    scoped = new Map();
    calls.set(key, scoped);
  }
  // A retried start receipt cannot reopen a call that has already closed.
  if (kind === 'call_closed' || !scoped.has(callId)) scoped.set(callId, kind === 'call_started');
}
export function hasActiveWorkHubVoiceCall(path: string): boolean {
  return [...(calls.get(resolve(path))?.values() ?? [])].some(Boolean);
}

export function activeWorkHubVoiceCallId(path: string): string | undefined {
  return [...(calls.get(resolve(path))?.entries() ?? [])]
    .reverse()
    .find(([, active]) => active)?.[0];
}
