import { createDefaultRuntimePolicy } from '@maka/core/runtime-policy';

export function disabledWebToolsRuntimePolicyDocument() {
  const policy = createDefaultRuntimePolicy();
  return {
    schemaVersion: 2 as const,
    revision: 0,
    policy: {
      ...policy,
      privacy: { incognitoActive: true },
      webSearch: { ...policy.webSearch, enabled: false },
    },
  };
}
