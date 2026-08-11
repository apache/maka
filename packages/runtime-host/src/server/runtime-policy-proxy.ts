import type { RuntimePolicy } from '@maka/core/runtime-policy';
import type { ProxiedFetchProxy } from '@maka/runtime/network/scoped-fetch-transport';

export function toRuntimePolicyProxy(
  proxy: RuntimePolicy['networkProxy'],
  password: string | undefined,
): ProxiedFetchProxy | null {
  if (!proxy.enabled) return null;
  if (proxy.authEnabled && password === undefined) {
    throw new Error('Network proxy execution admission omitted its credential');
  }
  return {
    enabled: true,
    type: proxy.protocol,
    host: proxy.host,
    port: proxy.port,
    ...(proxy.authEnabled ? { username: proxy.username, password } : {}),
    bypassList: [...new Set([...proxy.bypassList, ...proxy.autoBypassDomains])],
  };
}
