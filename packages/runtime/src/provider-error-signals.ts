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

/** Provider codes that identify an account-level usage or billing condition. */
export const PROVIDER_BILLING_PROVIDER_CODES: ReadonlySet<string> = new Set([
  'insufficient_quota',
  'insufficient_balance',
  'quota_exceeded',
  'freeusagelimiterror',
  'upgrade_required',
]);

/** Codes emitted by the incremental Responses transport before an HTTP response. */
export const OPENAI_RESPONSES_TRANSPORT_CODES: ReadonlySet<string> = new Set([
  'OPENAI_RESPONSES_WEBSOCKET_TRANSPORT_ERROR',
  'OPENAI_RESPONSES_CONTINUATION_UNAVAILABLE',
]);
