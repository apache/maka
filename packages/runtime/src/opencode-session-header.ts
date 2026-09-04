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

import type { ProviderType } from '@maka/core/llm-connections';

export const OPENCODE_SESSION_HEADER = 'x-opencode-session';

/** Adds OpenCode Go's session identity without overriding an explicit header. */
export function withOpenCodeSessionHeader(
  providerType: ProviderType,
  sessionId: string | undefined,
  headers?: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> | undefined {
  const normalizedSessionId = sessionId?.trim();
  if (providerType !== 'opencode-go' || !normalizedSessionId) return headers;
  if (Object.keys(headers ?? {}).some((name) => name.toLowerCase() === OPENCODE_SESSION_HEADER)) {
    return headers;
  }
  return { ...headers, [OPENCODE_SESSION_HEADER]: normalizedSessionId };
}
