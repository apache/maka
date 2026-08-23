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

import type {
  PricingConfig,
  UsageBucket,
  UsageGroupBy,
  UsageLogRow,
  UsageQuery,
  UsageSummaryV2,
} from '@maka/core/usage-stats/types';
import {
  type PersistedLlmCallRecord,
  type PersistedToolInvocationRecord,
} from './telemetry-file-schema.js';

export type {
  PersistedLlmCallRecord,
  PersistedToolInvocationRecord,
} from './telemetry-file-schema.js';

export interface ToolUsageQuery {
  readonly range: UsageQuery['range'];
  readonly toolName?: string;
  readonly status?: UsageQuery['status'];
}

export interface TelemetryRepo {
  insertLlmCall(record: PersistedLlmCallRecord): Promise<void>;
  insertToolInvocation(record: PersistedToolInvocationRecord): Promise<void>;
  summary(query: UsageQuery): UsageSummaryV2;
  buckets(query: UsageQuery, groupBy: UsageGroupBy): UsageBucket[];
  logs(query: UsageQuery, offset?: number, limit?: number): { rows: UsageLogRow[]; total: number };
  toolLogs(
    query: ToolUsageQuery,
    offset?: number,
    limit?: number,
  ): { rows: PersistedToolInvocationRecord[]; total: number };
  latestLlmRuntimeProbe(connectionSlug: string, modelId?: string): UsageLogRow | undefined;
  listPricingOverrides(): PricingConfig[];
  upsertPricing(pricing: PricingConfig): Promise<void>;
  deletePricing(modelKey: string): Promise<void>;
  load(): Promise<void>;
  flush(): Promise<void>;
  close(): Promise<void>;
}

export interface CreateTelemetryRepoOptions {
  readonly createIfMissing?: boolean;
  readonly managePricing?: boolean;
}

export class TelemetryRepoClosedError extends Error {
  constructor() {
    super('Telemetry repository is draining or closed');
    this.name = 'TelemetryRepoClosedError';
  }
}

export class TelemetryRepoNotLoadedError extends Error {
  constructor() {
    super('Telemetry repository has not been loaded');
    this.name = 'TelemetryRepoNotLoadedError';
  }
}

export class TelemetryQueryValidationError extends Error {
  constructor(message: string) {
    super(`Invalid telemetry query: ${message}`);
    this.name = 'TelemetryQueryValidationError';
  }
}

export class TelemetryRepoPublicationError extends Error {
  readonly domain = 'telemetry_authority';

  constructor(
    readonly commitUnknown: boolean,
    options: { cause: unknown },
  ) {
    super(
      commitUnknown
        ? 'Telemetry publication outcome is unknown; reopen before retrying'
        : 'Unable to publish telemetry',
      options,
    );
    this.name = 'TelemetryRepoPublicationError';
  }
}

export function resolveRange(range: UsageQuery['range']): { from: number; to: number } {
  if (typeof range === 'object') return range;
  const now = Date.now();
  switch (range) {
    case '24h':
      return { from: now - 24 * 60 * 60 * 1000, to: now };
    case '7d':
      return { from: now - 7 * 24 * 60 * 60 * 1000, to: now };
    case '30d':
      return { from: now - 30 * 24 * 60 * 60 * 1000, to: now };
    case 'all':
      return { from: 0, to: now };
  }
}
