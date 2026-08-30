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

import { createHash } from 'node:crypto';

export const CODE_MODE_NESTED_TOOL_CALL_ID_MAX_CHARS = 128;

const HASH_DOMAIN = 'maka.code-mode.nested-tool-call-id.v1';
const HASHED_PREFIX = 'code_nested_v1_';

/**
 * Keeps the historical readable identity while it fits the Host opaque-id
 * contract, then falls back to a domain-separated digest. The complete parent
 * identity remains available separately as `parentToolCallId`.
 */
export function codeModeNestedToolCallId(
  parentToolCallId: string,
  childToolCallId: string,
): string {
  const candidate = `${parentToolCallId}:nested:${childToolCallId}`;
  if (candidate.length <= CODE_MODE_NESTED_TOOL_CALL_ID_MAX_CHARS) return candidate;
  const digest = createHash('sha256')
    .update(JSON.stringify([HASH_DOMAIN, parentToolCallId, childToolCallId]), 'utf8')
    .digest('hex');
  return `${HASHED_PREFIX}${digest}`;
}
