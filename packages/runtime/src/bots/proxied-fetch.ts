import {
  fetch,
  Response as UndiciResponse,
  type Dispatcher,
  type RequestInit as UndiciRequestInit,
} from 'undici';
import { matchesBypassList } from '../network/bypass-matcher.js';
import { buildProxyDispatcher } from '../network/proxy-dispatcher.js';
import { resolveActiveProxy } from '../network/active-proxy-state.js';

const DEFAULT_TIMEOUT_MS = 15_000;

export type ProxiedFetchInit = UndiciRequestInit & {
  signal?: AbortSignal;
  timeoutMs?: number;
};

// Ties dispatcher/listener cleanup to the response body instead of the
// function stack (#2126). The body is re-wrapped so we learn when it reaches
// EOF, errors, or is cancelled; `settled` resolves at that point and never
// rejects. Null-body responses (204/304, HEAD) settle immediately.
function observeBodySettle(response: Response): { response: Response; settled: Promise<void> } {
  const body = response.body;
  if (!body) return { response, settled: Promise.resolve() };
  let settle!: () => void;
  const settled = new Promise<void>((resolve) => {
    settle = resolve;
  });
  const reader = body.getReader();
  const observed = new ReadableStream<Uint8Array>({
    async pull(streamController) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          settle();
          streamController.close();
          return;
        }
        streamController.enqueue(value);
      } catch (error) {
        settle();
        streamController.error(error);
      }
    },
    async cancel(reason) {
      settle();
      await reader.cancel(reason).catch(() => {});
    },
  });
  const rewrapped = new UndiciResponse(observed, {
    status: response.status,
    statusText: response.statusText,
    headers: [...response.headers],
  }) as unknown as Response;
  // The Response constructor cannot carry these; preserve the Fetch contract
  // for consumers that read where the response actually came from.
  Object.defineProperty(rewrapped, 'url', { value: response.url });
  Object.defineProperty(rewrapped, 'redirected', { value: response.redirected });
  return { response: rewrapped, settled };
}

export async function proxiedFetch(url: string, init: ProxiedFetchInit = {}): Promise<Response> {
  const proxy = resolveActiveProxy();
  let dispatcher: Dispatcher | undefined;
  if (proxy && !matchesBypassList(new URL(url).hostname, proxy.bypassList)) {
    dispatcher = buildProxyDispatcher(proxy) as Dispatcher;
  }
  const { timeoutMs = DEFAULT_TIMEOUT_MS, signal, ...fetchInit } = init;
  const timeoutEnabled = timeoutMs > 0;
  const controller = new AbortController();
  let timedOut = false;

  const disposeDispatcher = async (force = false) => {
    const disposable = dispatcher as
      | {
          close?: () => Promise<void>;
          destroy?: (error?: Error) => void | Promise<void>;
        }
      | undefined;
    if (!disposable) return;
    if (force && typeof disposable.destroy === 'function') {
      await Promise.resolve(disposable.destroy.call(dispatcher, new Error('Fetch timeout'))).catch(
        () => {},
      );
      return;
    }
    if (typeof disposable.close === 'function')
      await disposable.close.call(dispatcher).catch(() => {});
  };

  const onCallerAbort = () => controller.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener('abort', onCallerAbort, { once: true });
  }
  const detachCallerAbort = () => signal?.removeEventListener('abort', onCallerAbort);

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = timeoutEnabled
    ? new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          controller.abort(new Error('Fetch timeout'));
          void disposeDispatcher(true);
          reject(new Error('Fetch timeout'));
        }, timeoutMs);
        controller.signal.addEventListener(
          'abort',
          () => {
            if (timer) clearTimeout(timer);
          },
          { once: true },
        );
      })
    : undefined;

  const request = fetch(url, { ...fetchInit, dispatcher, signal: controller.signal }).catch(
    (error) => {
      if (timedOut) return new Promise<never>(() => {});
      throw error;
    },
  );

  let response: Response;
  try {
    response = timeout
      ? ((await Promise.race([request, timeout])) as unknown as Response)
      : ((await request) as unknown as Response);
  } catch (error) {
    if (timer) clearTimeout(timer);
    detachCallerAbort();
    await disposeDispatcher(timedOut);
    throw error;
  }

  // Headers are in: return now and hand the per-request dispatcher to the
  // body's lifecycle (#2126). Awaiting close() here made a streaming caller
  // wait for body EOF before seeing the Response at all. close() is graceful,
  // letting the in-flight body finish before it resolves, so it is
  // intentionally not awaited. As before, the timeout bounds time-to-headers
  // only.
  if (timer) clearTimeout(timer);
  const { response: observed, settled } = observeBodySettle(response);
  void settled.then(detachCallerAbort);
  void disposeDispatcher(false).then(detachCallerAbort);
  return observed;
}
