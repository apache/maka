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

/** Transport for expected operation failures carried as stable codes. */
export class ExpectedOperationError<Code extends string> extends Error {
  constructor(readonly code: Code) {
    super(code);
    this.name = 'ExpectedOperationError';
  }
}

/** Redacted diagnostics channel for unexpected operation failures. */
export function reportUnexpectedError(scope: string, error: unknown): void {
  const detail = error instanceof Error ? (error.stack ?? `${error.name}: ${error.message}`) : String(error);
  console.error(`[${scope}] operation failed:`, redactSecrets(detail));
}

export function unexpectedErrorFallback(error: unknown, fallback: string, scope: string): string {
  reportUnexpectedError(scope, error);
  return fallback;
}
