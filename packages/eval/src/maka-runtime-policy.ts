import { createDefaultRuntimePolicy } from '@maka/core/runtime-policy';

export function disabledWebToolsRuntimePolicyDocument(proxyUrl?: string) {
  const policy = createDefaultRuntimePolicy();
  const proxy = proxyUrl ? new URL(proxyUrl) : undefined;
  return {
    schemaVersion: 2 as const,
    revision: 0,
    policy: {
      ...policy,
      ...(proxy
        ? {
            networkProxy: {
              ...policy.networkProxy,
              enabled: true,
              protocol: 'http' as const,
              host: proxy.hostname,
              port: Number(proxy.port || 80),
            },
          }
        : {}),
      privacy: { incognitoActive: true },
      webSearch: { ...policy.webSearch, enabled: false },
    },
  };
}
