import { Agent, ProxyAgent, type Dispatcher } from 'undici';

export interface ExternalProviderDispatcher {
  readonly dispatcher: Dispatcher;
  close(): Promise<void>;
}

export function createExternalProviderDispatcher(
  proxyUrl: string | undefined,
  options: {
    readonly headersTimeoutMs?: number;
    readonly bodyTimeoutMs?: number;
  } = {},
): ExternalProviderDispatcher {
  const base = proxyUrl ? new ProxyAgent(proxyUrl) : new Agent();
  const headersTimeout = timeout(options.headersTimeoutMs ?? 0, 'headersTimeoutMs');
  const bodyTimeout = timeout(options.bodyTimeoutMs ?? 0, 'bodyTimeoutMs');
  const dispatcher = base.compose(
    (dispatch) => (request, handler) =>
      dispatch({ ...request, headersTimeout, bodyTimeout }, handler),
  );
  return {
    dispatcher,
    close: () => base.close(),
  };
}

function timeout(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative integer`);
  }
  return value;
}
