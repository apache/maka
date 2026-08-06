import { defaultWorkspacePrivacyContext } from '@maka/core/incognito';
import { validateWorkspacePrivacyContext } from '@maka/core';
import {
  buildWebFetchTool,
  createLocalWebFetchExecutor,
  type WebFetchExecutor,
} from '@maka/runtime';

export function buildWebFetchAgentTool(input: {
  getPrivacyContext?: () => Promise<unknown>;
  executor?: WebFetchExecutor;
}) {
  const executor =
    input.executor ?? createLocalWebFetchExecutor({ fetch: globalThis.fetch });
  return buildWebFetchTool({
    fetch: async (request) => {
      const privacyPayload = await (
        input.getPrivacyContext?.() ?? defaultWorkspacePrivacyContext()
      );
      const privacy = validateWorkspacePrivacyContext(privacyPayload);
      if (!privacy.ok || privacy.value.incognitoActive) {
        throw new Error('WebFetch is disabled while privacy mode is active.');
      }
      return executor.fetch(request);
    },
  });
}
