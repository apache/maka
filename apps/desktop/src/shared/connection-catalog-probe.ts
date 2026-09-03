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

import type { ProviderType } from '@maka/core/llm-connections';
import type { RequestHeaderUpdate } from '@maka/core/runtime-policy';

/** The catalog-probe contract shared by main, preload, and renderer. */
export interface ConnectionCatalogProbeRequest {
  readonly providerType: ProviderType;
  /** The endpoint whose catalog should be read. Required: the probe exists to
   * learn about an endpoint the app has not met yet. */
  readonly baseUrl: string;
  readonly apiKey: string | null;
  /** Custom request headers the discovery request should carry. Mirrors the
   * save path, so a relay whose /models endpoint demands a header can still be
   * read before it is saved. */
  readonly requestHeaders?: readonly RequestHeaderUpdate[];
}

export interface ConnectionCatalogProbeModel {
  readonly id: string;
  readonly displayName?: string;
  readonly contextWindow?: number;
}

export type ConnectionCatalogProbeOutcome =
  | { readonly kind: 'ready'; readonly models: readonly ConnectionCatalogProbeModel[] }
  | {
      readonly kind: 'rejected';
      readonly reason:
        | 'provider_unsupported'
        | 'credential_not_configured'
        | 'base_url_not_configured'
        | 'slug_conflict';
    }
  | { readonly kind: 'failed'; readonly errorClass: string };
