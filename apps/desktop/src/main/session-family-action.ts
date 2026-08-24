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

import { revisionFamilySessionIds } from '@maka/core/session-revisions';

import { type SessionSummary } from '@maka/core/session';

export function requestsRevisionFamily(options: unknown): boolean {
  if (options === undefined) return false;
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new Error('Invalid session family action options');
  }
  const value = (options as { revisionFamily?: unknown }).revisionFamily;
  if (value === undefined) return false;
  if (typeof value !== 'boolean') throw new Error('Invalid revisionFamily option');
  return value;
}

export async function resolveSessionActionIds(
  listSessions: () => Promise<readonly SessionSummary[]>,
  sessionId: string,
  options: unknown,
): Promise<string[]> {
  if (!requestsRevisionFamily(options)) return [sessionId];
  return revisionFamilySessionIds(await listSessions(), sessionId);
}
