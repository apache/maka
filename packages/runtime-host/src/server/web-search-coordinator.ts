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

import { WEB_SEARCH_DEFAULT_LIMIT } from '@maka/core/web-search';
import type { OperationOutcome, WebSearchExecuteInput } from '../protocol/index.js';
import type { WebSearchOperationHandlerMap } from './operation-dispatcher.js';
import type { HostWebSearchService } from './web-search-tool.js';

const WEB_SEARCH_TEST_QUERY = 'maka ai assistant';

export class HostWebSearchCoordinator {
  readonly handlers: WebSearchOperationHandlerMap = {
    'web-search.execute': (input) => this.#execute(input),
  };

  constructor(private readonly service: HostWebSearchService) {}

  async #execute(input: WebSearchExecuteInput): Promise<OperationOutcome<'web-search.execute'>> {
    try {
      const result = await this.service.search({
        query: input.kind === 'query' ? input.query : WEB_SEARCH_TEST_QUERY,
        limit: input.kind === 'query' ? input.limit : WEB_SEARCH_DEFAULT_LIMIT,
        policy: {
          ...(input.kind === 'test' ? { provider: input.provider, bypassFeatureGate: true } : {}),
          ...(input.apiKey === undefined ? {} : { secretOverride: input.apiKey }),
        },
      });
      return { ok: true, result };
    } catch {
      return {
        ok: false,
        error: {
          code: 'internal_failure',
          message: 'Web Search execution failed',
        },
      };
    }
  }
}
