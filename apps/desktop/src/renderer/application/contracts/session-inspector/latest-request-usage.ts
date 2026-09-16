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

/**
 * The session's latest provider-counted request, or nothing.
 *
 * A token count belongs to one request on one route: it is a number in that
 * model's tokenizer, and it is only the session's latest if nothing newer
 * exists. The runtime enforces both when it reads an anchor back, refusing one
 * whose run header names another model or connection. A control that shows the
 * number has to enforce the same two facts or it will display a precise-looking
 * figure about a request the user is not making — model A's tokens against
 * model B's window, or a historical range's usage presented as current.
 *
 * So this refuses rather than approximates, and the three refusals are the
 * three normal states that break the pairing:
 *
 * - the loaded transcript range is not the session tail, so a newer request may
 *   exist that this range cannot see;
 * - the newest usage row carries no anchor, which is what manual `/compact`
 *   writes, so the scan continues past it exactly as the runtime's does;
 * - the anchor names a different route than the active one, or names none at
 *   all because it was written before anchors carried their route.
 */
export interface LatestRequestUsageAnchor {
  inputTokens: number;
  outputTokens?: number;
  modelId?: string;
  connectionId?: string;
}

export function selectLatestRequestUsage(
  messages: readonly { type: string; lastRequestAnchor?: LatestRequestUsageAnchor }[],
  /** `hasNewer` means the loaded range is not the session tail. */
  range: { hasNewer?: boolean } | undefined,
  model: string | undefined,
  route: { llmConnectionId?: string } | undefined,
): number | undefined {
  const connectionId = route?.llmConnectionId;
  if (range?.hasNewer || model === undefined || connectionId === undefined) return undefined;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.type !== 'token_usage') continue;
    const anchor = message.lastRequestAnchor;
    if (!anchor) continue;
    if (anchor.modelId !== model || anchor.connectionId !== connectionId) return undefined;
    if (!Number.isFinite(anchor.inputTokens) || anchor.inputTokens <= 0) return undefined;
    const output = Number.isFinite(anchor.outputTokens ?? 0) ? Math.max(0, anchor.outputTokens ?? 0) : 0;
    return anchor.inputTokens + output;
  }
  return undefined;
}
