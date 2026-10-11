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
import { parseDesktopSessionKey } from './runtime-host-identity.js';

/** Topic identity comes only from a successful, validated tasks association receipt. */
export function readWorkHubTopicAssociation(message: StoredMessage, expectedSessionId: string) {
  if (message.type !== 'tool_result' || message.isError) return;
  let result: unknown;
  if (message.content.kind === 'json') result = message.content.value;
  else if (message.content.kind === 'text') {
    try { result = JSON.parse(message.content.text); } catch { return; }
  }
  if (result && typeof result === 'object' && 'structuredContent' in result) result = result.structuredContent;
  if (!result || typeof result !== 'object' || !('operation' in result) || result.operation !== 'associate' ||
    !('targetSessionId' in result) || result.targetSessionId !== expectedSessionId ||
    !('targetSessionKey' in result) || typeof result.targetSessionKey !== 'string' ||
    !('targetSessionName' in result) || typeof result.targetSessionName !== 'string') return;
  try { if (parseDesktopSessionKey(result.targetSessionKey).sessionId !== expectedSessionId) return; }
  catch { return; }
  return { targetSessionId: expectedSessionId, targetSessionKey: result.targetSessionKey, targetSessionName: result.targetSessionName };
}

export function workHubAssociationTarget(message: StoredMessage): string | undefined {
  if (message.type !== 'tool_call' || message.toolName !== 'mcp__desktop_workhub__tasks') return;
  const args = message.args;
  const request = args && typeof args === 'object' && 'request' in args ? args.request : undefined;
  if (request && typeof request === 'object' && 'operation' in request && request.operation === 'associate' &&
    'targetSessionId' in request && typeof request.targetSessionId === 'string') return request.targetSessionId;
}
