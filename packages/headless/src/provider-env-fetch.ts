import { EnvHttpProxyAgent, fetch as undiciFetch } from 'undici';

export interface ProviderEnvFetch {
  fetch: typeof globalThis.fetch;
  close(): Promise<void>;
}

export function createProviderEnvFetch(
  env: NodeJS.ProcessEnv = process.env,
): ProviderEnvFetch | undefined {
  if (env.NODE_USE_ENV_PROXY !== '1') return undefined;
  const httpProxy = env.http_proxy ?? env.HTTP_PROXY;
  const httpsProxy = env.https_proxy ?? env.HTTPS_PROXY;
  if (!httpProxy && !httpsProxy) return undefined;

  const dispatcher = new EnvHttpProxyAgent({
    ...(httpProxy ? { httpProxy } : {}),
    ...(httpsProxy ? { httpsProxy } : {}),
    ...(env.no_proxy !== undefined || env.NO_PROXY !== undefined
      ? { noProxy: env.no_proxy ?? env.NO_PROXY }
      : {}),
  });
  return {
    fetch: async (input, init) =>
      (await undiciFetch(input as Parameters<typeof undiciFetch>[0], {
        ...(init as Parameters<typeof undiciFetch>[1]),
        dispatcher,
      })) as unknown as Response,
    close: () => dispatcher.close(),
  };
}
