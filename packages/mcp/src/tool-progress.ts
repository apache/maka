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

export interface McpToolProgress {
  readonly current: number;
  readonly total: number;
}

/**
 * Map an SDK `notifications/progress` payload onto the Host progress pair.
 * First slice: only finite step counts that the shared tool-progress codec
 * already accepts. Missing `total`, fractions, and inverted ranges are
 * dropped so a noisy server cannot fail the tool call.
 */
export function mapMcpToolProgress(value: unknown): McpToolProgress | undefined {
  if (!isRecord(value)) return undefined;
  const current = value.progress;
  const total = value.total;
  if (typeof current !== 'number' || typeof total !== 'number') return undefined;
  if (
    !Number.isSafeInteger(current) ||
    !Number.isSafeInteger(total) ||
    current < 0 ||
    total < 1 ||
    current > total
  ) {
    return undefined;
  }
  return { current, total };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
