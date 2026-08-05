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
