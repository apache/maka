import type { ProxySettings } from '@maka/core/settings/network-settings';
import { Agent, fetch as undiciFetch, type Dispatcher } from 'undici';
import type { ConnectionEffectFetch } from '../connection-effect-fetch.js';
import { matchesBypassList } from './bypass-matcher.js';
import { buildProxyDispatcher } from './proxy-dispatcher.js';

export interface ConnectionEffectProxySnapshot {
  readonly enabled: boolean;
  readonly type: ProxySettings['type'];
  readonly host: string;
  readonly port: number;
  readonly username?: string;
  readonly password?: string;
  readonly bypassList: readonly string[];
}

export interface ConnectionEffectFetchTransport {
  readonly fetch: ConnectionEffectFetch;
  close(): Promise<void>;
}

export function createConnectionEffectFetchTransport(
  proxy: ConnectionEffectProxySnapshot | null,
): ConnectionEffectFetchTransport {
  const proxySnapshot: ProxySettings | null = proxy?.enabled
    ? { ...proxy, bypassList: [...proxy.bypassList] }
    : null;
  const directDispatcher = new Agent();
  let proxyDispatcher: Dispatcher | undefined;
  let closePromise: Promise<void> | undefined;
  let closed = false;

  const fetch: ConnectionEffectFetch = async (input, init) => {
    if (closed) throw new Error('Connection effect fetch transport is closed');

    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const useProxy =
      proxySnapshot !== null && !matchesBypassList(new URL(url).hostname, proxySnapshot.bypassList);
    if (useProxy) proxyDispatcher ??= buildProxyDispatcher(proxySnapshot) as Dispatcher;

    return (await undiciFetch(
      input as Parameters<typeof undiciFetch>[0],
      {
        ...init,
        dispatcher: useProxy ? proxyDispatcher : directDispatcher,
      } as Parameters<typeof undiciFetch>[1],
    )) as unknown as Response;
  };

  const close = (): Promise<void> => {
    if (closePromise) return closePromise;
    closed = true;
    closePromise = Promise.all([
      directDispatcher
        .destroy(new Error('Connection effect fetch transport closed'))
        .catch(() => {}),
      proxyDispatcher
        ?.destroy(new Error('Connection effect fetch transport closed'))
        .catch(() => {}),
    ]).then(() => undefined);
    return closePromise;
  };

  return { fetch, close };
}
