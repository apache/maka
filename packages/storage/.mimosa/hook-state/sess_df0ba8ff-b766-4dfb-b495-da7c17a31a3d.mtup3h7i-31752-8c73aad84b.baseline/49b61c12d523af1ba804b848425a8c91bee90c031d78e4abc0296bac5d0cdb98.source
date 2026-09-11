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

import type { PricingConfig } from '@maka/core/usage-stats/types';

export interface PricingSnapshot {
  readonly revision: number;
  readonly overrides: readonly Readonly<PricingConfig>[];
}

export interface PricingMutationResult {
  readonly committed: boolean;
  readonly changed: boolean;
  readonly snapshot: PricingSnapshot;
}

export interface PricingStore {
  snapshot(): PricingSnapshot;
  upsert(expectedRevision: number, pricing: PricingConfig): Promise<PricingMutationResult>;
  delete(expectedRevision: number, modelKey: string): Promise<PricingMutationResult>;
  load(): Promise<void>;
  flush(): Promise<void>;
  beginDrain(): Promise<void>;
  close(): Promise<void>;
}

export interface CreatePricingStoreOptions {
  readonly createIfMissing?: boolean;
}

export class PricingStoreClosedError extends Error {
  constructor() {
    super('Pricing store is draining or closed');
    this.name = 'PricingStoreClosedError';
  }
}

export class PricingStoreNotLoadedError extends Error {
  constructor() {
    super('Pricing store has not been loaded');
    this.name = 'PricingStoreNotLoadedError';
  }
}

export class PricingRevisionConflictError extends Error {
  constructor(
    readonly expectedRevision: number,
    readonly actualRevision: number,
  ) {
    super(`Pricing revision conflict: expected ${expectedRevision}, actual ${actualRevision}`);
    this.name = 'PricingRevisionConflictError';
  }
}

export class PricingValidationError extends Error {
  constructor(message: string) {
    super(`Invalid pricing authority: ${message}`);
    this.name = 'PricingValidationError';
  }
}

export class PricingStorePublicationError extends Error {
  readonly domain = 'pricing_authority';

  constructor(options: { cause: unknown }) {
    super('Unable to publish pricing authority', options);
    this.name = 'PricingStorePublicationError';
  }
}

export class PricingCommitUnknownError extends Error {
  readonly domain = 'pricing_authority';

  constructor(options: { cause: unknown }) {
    super('Pricing commit outcome is unknown; reload before retrying', options);
    this.name = 'PricingCommitUnknownError';
  }
}
