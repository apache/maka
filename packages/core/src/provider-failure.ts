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

export const PROVIDER_FAILURE_CLASSES = [
  'Abort',
  'Auth',
  'ContextLength',
  'Network',
  'Other',
  'ProviderBilling',
  'ProviderCapacity',
  'ProviderPermission',
  'ProviderUnavailable',
  'RateLimit',
  'RequestRejected',
  'Timeout',
  'UsageLimit',
] as const;

export type ProviderFailureClass = (typeof PROVIDER_FAILURE_CLASSES)[number];

/**
 * One provider-owned failure interpretation produced at the Runtime boundary.
 * Consumers may project or persist these fields, but must not rebuild the
 * taxonomy from HTTP status or message text.
 */
export interface ProviderFailureResult {
  readonly errorClass: ProviderFailureClass;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  readonly httpStatus?: number;
  readonly providerCode?: string;
  readonly providerRequestId?: string;
  readonly message?: string;
  /** Proves that `message` was allowlisted, redacted, and bounded by Runtime. */
  readonly boundedProviderMessage?: true;
}

export function isProviderFailureClass(value: unknown): value is ProviderFailureClass {
  return (PROVIDER_FAILURE_CLASSES as readonly unknown[]).includes(value);
}
