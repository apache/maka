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

import { truncateUtf8 } from '@maka/core/diagnostic-log';
import { redactSecrets } from '@maka/core/redaction';

const CONVERSATION_COPY_COMMIT_FAILURE = 'Session conversation copy could not be committed';
const OPERATION_ERROR_MESSAGE_MAX_UTF8_BYTES = 1024;
const HOST_DIAGNOSTIC_MAX_UTF8_BYTES = 8 * 1024;

export function conversationCopyCommitFailureMessage(error: unknown): string {
  const detail = redactSecrets(conversationCopyCommitErrorSummary(error)).trim();
  if (!detail) return CONVERSATION_COPY_COMMIT_FAILURE;
  return truncateUtf8(
    `${CONVERSATION_COPY_COMMIT_FAILURE}: ${detail}`,
    OPERATION_ERROR_MESSAGE_MAX_UTF8_BYTES,
    '…',
  );
}

export function conversationCopyCommitFailureDiagnostic(error: unknown): string {
  let detail: string | undefined;
  try {
    detail = error instanceof Error ? error.stack : undefined;
  } catch {
    // A hostile Error subclass must not prevent rollback from running.
  }
  return truncateUtf8(
    redactSecrets(detail || conversationCopyCommitErrorSummary(error)),
    HOST_DIAGNOSTIC_MAX_UTF8_BYTES,
    '\n<diagnostic truncated>',
  );
}

function conversationCopyCommitErrorSummary(error: unknown): string {
  try {
    const candidate = isRecord(error) ? error : undefined;
    const rawCode = candidate?.code;
    const code =
      typeof rawCode === 'string' || (typeof rawCode === 'number' && Number.isFinite(rawCode))
        ? String(rawCode)
        : undefined;
    const message =
      typeof candidate?.message === 'string'
        ? candidate.message
        : typeof error === 'string'
          ? error
          : String(error);
    if (!code || message.toLowerCase().includes(code.toLowerCase())) return message;
    return message ? `${code}: ${message}` : code;
  } catch {
    return 'Unknown error';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
