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

import type { Readable } from 'node:stream';
import { RUNTIME_HOST_OPERATOR_RETIREMENT_CANCELLATION_ENV } from '@maka/runtime-host/operator';

/** Consume the operator's one-shot cancellation channel only around reversible retirement. */
export function withOperatorRetirementCancellation<T>(
  operation: (signal: AbortSignal | undefined) => Promise<T>,
): Promise<T> {
  if (process.env[RUNTIME_HOST_OPERATOR_RETIREMENT_CANCELLATION_ENV] !== '1') {
    return operation(undefined);
  }
  // Recovery may retire another owner later. It must finish independently of
  // the original user's cancellation, and activators must not inherit this channel.
  delete process.env[RUNTIME_HOST_OPERATOR_RETIREMENT_CANCELLATION_ENV];
  return withRetirementCancellation(process.stdin, operation);
}

export async function withRetirementCancellation<T>(
  input: Readable,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const cancel = () => controller.abort(new Error('Runtime Host retirement was cancelled'));
  input.once('end', cancel);
  input.once('error', cancel);
  input.once('close', cancel);
  input.resume();
  if (input.readableEnded || input.destroyed) cancel();
  try {
    return await operation(controller.signal);
  } finally {
    input.removeListener('end', cancel);
    input.removeListener('error', cancel);
    input.removeListener('close', cancel);
    input.pause();
    // A parent's still-open cancellation pipe must not keep the completed CLI alive.
    (input as Readable & { unref?: () => void }).unref?.();
  }
}
