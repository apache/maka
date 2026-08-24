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

import { redactSecrets } from '@maka/core/redaction';

export const MCP_IDENTITY_DIAGNOSTIC_CODE_POINTS = 80;
export const MCP_ERROR_DIAGNOSTIC_CODE_POINTS = 2_000;
export const MCP_DIAGNOSTIC_INPUT_CODE_UNITS = 8_192;
const OVERSIZED_MCP_DIAGNOSTIC = '[MCP diagnostic omitted: input exceeded limit]';

/** Render untrusted MCP text without control spoofing, secrets, or unbounded output. */
export function formatMcpDiagnosticText(
  value: string,
  maxCodePoints = MCP_IDENTITY_DIAGNOSTIC_CODE_POINTS,
): string {
  const outputLimit = normalizeOutputLimit(maxCodePoints);
  if (value.length > MCP_DIAGNOSTIC_INPUT_CODE_UNITS) {
    return [...OVERSIZED_MCP_DIAGNOSTIC].slice(0, outputLimit).join('');
  }
  const redacted = redactSecrets(value);
  const sanitized = redacted.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '\uFFFD');
  const codePoints = [...sanitized];
  if (codePoints.length <= outputLimit) return sanitized;
  return `${codePoints.slice(0, outputLimit - 1).join('')}\u2026`;
}

function normalizeOutputLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    return MCP_IDENTITY_DIAGNOSTIC_CODE_POINTS;
  }
  return Math.min(value, MCP_ERROR_DIAGNOSTIC_CODE_POINTS);
}
