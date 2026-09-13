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

import type { UsageGroupBy } from './types.js';
import { pricingModelKey } from './pricing.js';

/**
 * The bucket key for one model call, shared by every Usage source.
 *
 * Usage answers merge the canonical `ModelCallAttempt` ledger with the frozen
 * pre-cutover table, and that merge groups by exact key. Two sources deriving
 * "the same hour" differently — an epoch-hour ordinal on one side, an ISO hour
 * on the other — silently split one hour into two buckets rather than failing,
 * so the key has to come from one place.
 */
export function usageBucketKey(
  call: { readonly providerId: string; readonly modelId: string; readonly ts: number },
  groupBy: UsageGroupBy,
): string {
  switch (groupBy) {
    case 'provider':
      return call.providerId;
    case 'model':
      return pricingModelKey(call.providerId, call.modelId);
    case 'day':
      return new Date(call.ts).toISOString().slice(0, 10);
    case 'hour':
      return new Date(call.ts).toISOString().slice(0, 13);
    case 'tool':
      return '';
  }
}
