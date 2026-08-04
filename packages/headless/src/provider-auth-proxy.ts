import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  createServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from 'node:http';
import type { Socket } from 'node:net';
import { Agent, type Dispatcher, Headers, fetch as upstreamFetch } from 'undici';

/** Upstream connections must stay on HTTP/1.1. Providers negotiate h2 via
 * ALPN, and undici <= 8.7 (bundled in Node 26) refuses to multiplex
 * stream/async-iterable request bodies on an h2 session with requests in
 * flight, while its fetch wraps every non-empty body into an async iterable —
 * so concurrent streaming completions from parallel cells serialized behind
 * each other's full generation streams, recorded as provider first-token
 * latency. undici 8.8 removed that gate, but forcing h1 keeps the proxy
 * independent of which undici build serves the fetch: h1 pools sidestep the
 * whole class by dialing parallel connections. */
export function createProviderUpstreamDispatcher(options: Agent.Options = {}): Dispatcher {
  return new Agent({ ...options, allowH2: false });
}

const defaultUpstreamDispatcher = createProviderUpstreamDispatcher();

export interface ProviderAuthProxy {
  baseUrl: string;
  token: string;
  usage(): ProviderTokenUsage | null;
  telemetry(): ProviderRequestTelemetry[];
  close(): Promise<void>;
}

export interface ProviderAuthProxyHub {
  baseUrl: string;
  issue(input: ProviderAuthProxyRouteInput): ProviderAuthProxy;
  close(): Promise<void>;
}

export interface ProviderTokenUsage {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  /** Present only when the provider reports a reasoning-token breakdown. */
  reasoning?: number;
}

export interface ProviderRequestTelemetry {
  requestId: number;
  method: string;
  path: string;
  protocol?: ProviderUsageProtocol;
  status?: number;
  outcome: 'completed' | 'interrupted' | 'failed' | 'aborted';
  /** When the dispatcher started writing the request to an upstream
   * connection. Time before this is credential resolution, request-body read,
   * and the dispatcher's connection queue; `responseHeadersMs` minus this is
   * pure upstream wait. The h2 serialization defect hid inside this interval
   * while `responseHeadersMs` alone read as provider latency. */
  upstreamStartMs?: number;
  responseHeadersMs?: number;
  firstBodyChunkMs?: number;
  firstOutputTokenMs?: number;
  lastOutputTokenMs?: number;
  firstReasoningTokenMs?: number;
  lastReasoningTokenMs?: number;
  /** First non-reasoning output after reasoning began. */
  reasoningEndMs?: number;
  /** Largest observed interval between adjacent upstream body chunks. */
  maxBodyChunkGapMs?: number;
  durationMs: number;
  bodyChunks: number;
  responseBytes: number;
  terminalEvent: boolean;
  usage?: ProviderTokenUsage;
  errorClass?: string;
}

export interface ProviderTelemetrySummary {
  requests: number;
  completed: number;
  interrupted: number;
  failed: number;
  aborted: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number | null;
  usageMeasuredRequests: number;
  reasoningMeasuredRequests: number;
  outputTokensPerSecond: number | null;
  reasoningTokensPerSecond: number | null;
  maxBodyChunkGapMs: number | null;
}

export function summarizeProviderTelemetry(
  requests: readonly ProviderRequestTelemetry[],
): ProviderTelemetrySummary {
  let inputTokens = 0;
  let outputTokens = 0;
  let reasoningTokens = 0;
  let usageMeasuredRequests = 0;
  let reasoningMeasuredRequests = 0;
  let outputGenerationMs = 0;
  let outputRateTokens = 0;
  let reasoningGenerationMs = 0;
  let reasoningRateTokens = 0;
  let maxBodyChunkGapMs: number | null = null;
  for (const request of requests) {
    if (request.maxBodyChunkGapMs !== undefined) {
      maxBodyChunkGapMs = Math.max(maxBodyChunkGapMs ?? 0, request.maxBodyChunkGapMs);
    }
    if (!request.usage) continue;
    usageMeasuredRequests += 1;
    inputTokens += request.usage.input;
    outputTokens += request.usage.output;
    if (
      request.firstOutputTokenMs !== undefined &&
      request.lastOutputTokenMs !== undefined &&
      request.lastOutputTokenMs > request.firstOutputTokenMs
    ) {
      outputGenerationMs += request.lastOutputTokenMs - request.firstOutputTokenMs;
      outputRateTokens += request.usage.output;
    }
    if (request.usage.reasoning !== undefined) {
      reasoningMeasuredRequests += 1;
      reasoningTokens += request.usage.reasoning;
      if (
        request.firstReasoningTokenMs !== undefined &&
        request.lastReasoningTokenMs !== undefined &&
        request.lastReasoningTokenMs > request.firstReasoningTokenMs
      ) {
        reasoningGenerationMs += request.lastReasoningTokenMs - request.firstReasoningTokenMs;
        reasoningRateTokens += request.usage.reasoning;
      }
    }
  }
  const count = (outcome: ProviderRequestTelemetry['outcome']) =>
    requests.filter((request) => request.outcome === outcome).length;
  return {
    requests: requests.length,
    completed: count('completed'),
    interrupted: count('interrupted'),
    failed: count('failed'),
    aborted: count('aborted'),
    inputTokens,
    outputTokens,
    reasoningTokens: reasoningMeasuredRequests > 0 ? reasoningTokens : null,
    usageMeasuredRequests,
    reasoningMeasuredRequests,
    outputTokensPerSecond:
      outputGenerationMs > 0 ? outputRateTokens / (outputGenerationMs / 1_000) : null,
    reasoningTokensPerSecond:
      reasoningGenerationMs > 0 ? reasoningRateTokens / (reasoningGenerationMs / 1_000) : null,
    maxBodyChunkGapMs,
  };
}

export type ProviderAuthProxyMode = 'bearer' | 'x-api-key';
export type ProviderUsageProtocol = 'anthropic-sse' | 'openai-chat-sse' | 'openai-responses-sse';

export interface ProviderUpstreamCredential {
  value: string;
  headers?: Readonly<Record<string, string>>;
}

export type ProviderUpstreamCredentialResolver = (
  signal?: AbortSignal,
) => Promise<ProviderUpstreamCredential>;

type ProviderAuthProxyRouteConfig = {
  upstreamBaseUrl: string;
  clientAuthMode?: ProviderAuthProxyMode;
  upstreamAuthMode?: ProviderAuthProxyMode;
  usageProtocol?: ProviderUsageProtocol;
  /** Injectable monotonic clock for deterministic tests. */
  now?: () => number;
  /** Injectable upstream dispatcher for tests (e.g. to trust a test CA).
   * Build it with createProviderUpstreamDispatcher to keep h2 disabled. */
  upstreamDispatcher?: Dispatcher;
} & (
  | { apiKeyFile: string; resolveUpstreamCredential?: never }
  | { apiKeyFile?: never; resolveUpstreamCredential: ProviderUpstreamCredentialResolver }
);

export type ProviderAuthProxyRouteInput = ProviderAuthProxyRouteConfig;

type ProviderAuthProxyInput = ProviderAuthProxyRouteConfig & {
  advertisedHost?: string;
  /** Fixed listen port. Defaults to an ephemeral port (0). Pier's Squid egress
   * for offline tasks only permits destination ports 80/443, so a container
   * reaching this proxy through Squid needs it bound to 80 or 443. Binding a
   * privileged port can fail on Linux; callers get a clear error. */
  port?: number;
};

export interface ProviderAuthProxyHubInput {
  advertisedHost?: string;
  port?: number;
}

export async function startProviderAuthProxy(
  input: ProviderAuthProxyInput,
): Promise<ProviderAuthProxy> {
  const hub = await startProviderAuthProxyHub({
    ...(input.advertisedHost ? { advertisedHost: input.advertisedHost } : {}),
    ...(input.port !== undefined ? { port: input.port } : {}),
  });
  let lease: ProviderAuthProxy;
  try {
    lease = hub.issue(input);
  } catch (error) {
    await hub.close();
    throw error;
  }
  let closePromise: Promise<void> | undefined;
  return {
    ...lease,
    close: () => {
      closePromise ??= lease.close().then(() => hub.close());
      return closePromise;
    },
  };
}

interface ProviderAuthProxyRoute {
  readonly upstreamBaseUrl: URL;
  readonly upstreamBasePath: string;
  readonly resolveUpstreamCredential: ProviderUpstreamCredentialResolver;
  readonly token: string;
  readonly clientAuthMode: ProviderAuthProxyMode;
  readonly upstreamAuthMode: ProviderAuthProxyMode;
  readonly usageProtocol?: ProviderUsageProtocol;
  readonly usage: ProviderUsageAccumulator;
  readonly telemetry: ProviderTelemetryAccumulator;
  readonly now: () => number;
  readonly upstreamDispatcher: Dispatcher;
  readonly activeRequests: Set<AbortController>;
  readonly activeResponses: Set<ServerResponse>;
  readonly activeForwards: Set<Promise<void>>;
  closePromise?: Promise<void>;
}

export async function startProviderAuthProxyHub(
  input: ProviderAuthProxyHubInput = {},
): Promise<ProviderAuthProxyHub> {
  const routes = new Set<ProviderAuthProxyRoute>();
  const sockets = new Set<Socket>();
  let closed = false;
  let closePromise: Promise<void> | undefined;
  const server = createServer((request, response) => {
    const route = [...routes].find((candidate) => routeAuthorized(request, candidate));
    if (!route) {
      response.writeHead(401).end('unauthorized');
      return;
    }
    const controller = new AbortController();
    const abortOnRequest = () => controller.abort();
    const abortOnResponseClose = () => {
      if (!response.writableEnded) controller.abort();
    };
    request.once('aborted', abortOnRequest);
    response.once('close', abortOnResponseClose);
    route.activeRequests.add(controller);
    route.activeResponses.add(response);
    const forward = forwardProviderRequest({
      request,
      response,
      upstreamBaseUrl: route.upstreamBaseUrl,
      upstreamBasePath: route.upstreamBasePath,
      resolveUpstreamCredential: route.resolveUpstreamCredential,
      token: route.token,
      clientAuthMode: route.clientAuthMode,
      upstreamAuthMode: route.upstreamAuthMode,
      usageProtocol: route.usageProtocol,
      usage: route.usage,
      telemetry: route.telemetry,
      now: route.now,
      upstreamDispatcher: route.upstreamDispatcher,
      signal: controller.signal,
    }).finally(() => {
      request.off('aborted', abortOnRequest);
      response.off('close', abortOnResponseClose);
      route.activeRequests.delete(controller);
      route.activeResponses.delete(response);
      route.activeForwards.delete(forward);
    });
    route.activeForwards.add(forward);
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  await listenProviderAuthProxyServer(server, input.port ?? 0);
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('provider auth proxy did not bind a TCP port');
  }
  const advertisedHost = input.advertisedHost ?? 'host.docker.internal';
  const baseUrl = `http://${advertisedHost}:${address.port}`;

  return {
    baseUrl,
    issue: (routeInput) => {
      if (closed) throw new Error('provider auth proxy hub is closed');
      const route = providerAuthProxyRoute(routeInput);
      routes.add(route);
      return {
        // Preserve the route's provider mount path while every lease shares the
        // listener authority. The client remains the sole owner of path joins.
        baseUrl: `${baseUrl}${route.upstreamBasePath}`,
        token: route.token,
        usage: () => route.usage.snapshot(),
        telemetry: () => route.telemetry.snapshot(),
        close: () => closeProviderAuthProxyRoute(routes, route),
      };
    },
    close: () => {
      closePromise ??= (async () => {
        closed = true;
        const serverClosed = new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
        const routeClosures = [...routes].map((route) =>
          closeProviderAuthProxyRoute(routes, route),
        );
        for (const socket of sockets) socket.destroy();
        await serverClosed;
        await Promise.allSettled(routeClosures);
      })();
      return closePromise;
    },
  };
}

function providerAuthProxyRoute(input: ProviderAuthProxyRouteInput): ProviderAuthProxyRoute {
  const upstreamBaseUrl = new URL(input.upstreamBaseUrl);
  if (upstreamBaseUrl.protocol !== 'https:' && upstreamBaseUrl.protocol !== 'http:') {
    throw new Error(
      `provider auth proxy requires an HTTP(S) upstream: ${upstreamBaseUrl.protocol}`,
    );
  }
  const upstreamBasePath = normalizeProxyBasePath(upstreamBaseUrl.pathname);
  const resolveUpstreamCredential =
    input.resolveUpstreamCredential ??
    (async (signal) => {
      const value = (
        await readFile(input.apiKeyFile, {
          encoding: 'utf8',
          ...(signal ? { signal } : {}),
        })
      ).trim();
      if (value.length === 0) throw new Error('provider API key file is empty');
      return { value };
    });
  return {
    upstreamBaseUrl,
    upstreamBasePath,
    resolveUpstreamCredential,
    token: randomBytes(32).toString('hex'),
    clientAuthMode: input.clientAuthMode ?? 'bearer',
    upstreamAuthMode: input.upstreamAuthMode ?? 'bearer',
    ...(input.usageProtocol ? { usageProtocol: input.usageProtocol } : {}),
    usage: new ProviderUsageAccumulator(),
    telemetry: new ProviderTelemetryAccumulator(),
    now: input.now ?? performance.now.bind(performance),
    upstreamDispatcher: input.upstreamDispatcher ?? defaultUpstreamDispatcher,
    activeRequests: new Set<AbortController>(),
    activeResponses: new Set<ServerResponse>(),
    activeForwards: new Set<Promise<void>>(),
  };
}

function routeAuthorized(request: IncomingMessage, route: ProviderAuthProxyRoute): boolean {
  const presentedCredential =
    route.clientAuthMode === 'x-api-key'
      ? request.headers['x-api-key']
      : request.headers.authorization;
  return authorized(presentedCredential, route.token, route.clientAuthMode);
}

function closeProviderAuthProxyRoute(
  routes: Set<ProviderAuthProxyRoute>,
  route: ProviderAuthProxyRoute,
): Promise<void> {
  route.closePromise ??= (async () => {
    routes.delete(route);
    const forwards = [...route.activeForwards];
    for (const controller of route.activeRequests) controller.abort();
    for (const response of route.activeResponses) response.destroy();
    await Promise.allSettled(forwards);
  })();
  return route.closePromise;
}

async function forwardProviderRequest(input: {
  request: IncomingMessage;
  response: ServerResponse;
  upstreamBaseUrl: URL;
  upstreamBasePath: string;
  resolveUpstreamCredential: ProviderUpstreamCredentialResolver;
  token: string;
  clientAuthMode: ProviderAuthProxyMode;
  upstreamAuthMode: ProviderAuthProxyMode;
  usageProtocol?: ProviderUsageProtocol;
  usage: ProviderUsageAccumulator;
  telemetry: ProviderTelemetryAccumulator;
  now: () => number;
  upstreamDispatcher: Dispatcher;
  signal: AbortSignal;
}): Promise<void> {
  let requestTelemetry: MutableProviderRequestTelemetry | null = null;
  try {
    const presentedCredential =
      input.clientAuthMode === 'x-api-key'
        ? input.request.headers['x-api-key']
        : input.request.headers.authorization;
    if (!authorized(presentedCredential, input.token, input.clientAuthMode)) {
      input.response.writeHead(401).end('unauthorized');
      return;
    }
    const startedAt = input.now();
    const incomingUrl = new URL(input.request.url ?? '/', 'http://provider-proxy');
    // A proxy token is scoped to this provider mount, not its entire origin.
    if (!pathIsWithinBasePath(incomingUrl.pathname, input.upstreamBasePath)) {
      input.response.writeHead(404).end('not found');
      return;
    }
    requestTelemetry = input.telemetry.start({
      method: input.request.method ?? 'GET',
      path: incomingUrl.pathname,
      protocol: input.usageProtocol,
      startedAt,
    });
    const upstreamCredential = await resolveUpstreamCredentialUntilAborted(
      input.resolveUpstreamCredential,
      input.signal,
    );
    if (upstreamCredential.value.length === 0) {
      throw new Error('provider credential resolver returned an empty value');
    }
    const upstreamUrl = new URL(input.upstreamBaseUrl);
    upstreamUrl.pathname = incomingUrl.pathname;
    upstreamUrl.search = incomingUrl.search;
    const headers = new Headers();
    for (const [name, value] of Object.entries(input.request.headers)) {
      if (value === undefined || REQUEST_HEADER_DENYLIST.has(name.toLowerCase())) continue;
      if (Array.isArray(value)) value.forEach((item) => headers.append(name, item));
      else headers.set(name, value);
    }
    if (input.upstreamAuthMode === 'x-api-key') headers.set('x-api-key', upstreamCredential.value);
    else headers.set('authorization', `Bearer ${upstreamCredential.value}`);
    for (const [name, value] of Object.entries(upstreamCredential.headers ?? {})) {
      headers.set(name, value);
    }
    const body =
      input.request.method === 'GET' || input.request.method === 'HEAD'
        ? undefined
        : await readRequestBody(input.request);
    const upstreamResponse = await upstreamFetch(upstreamUrl, {
      method: input.request.method,
      headers,
      signal: input.signal,
      dispatcher: upstreamStartTimedDispatcher(
        input.upstreamDispatcher,
        requestTelemetry,
        startedAt,
        input.now,
      ),
      ...(body ? { body: new Uint8Array(body) } : {}),
    });
    requestTelemetry.status = upstreamResponse.status;
    requestTelemetry.responseHeadersMs = elapsedMs(startedAt, input.now());
    const responseHeaders: Record<string, string> = {};
    upstreamResponse.headers.forEach((value, name) => {
      if (!HOP_BY_HOP_HEADERS.has(name.toLowerCase())) responseHeaders[name] = value;
    });
    input.response.writeHead(upstreamResponse.status, responseHeaders);
    input.response.flushHeaders();
    const responseUsage =
      input.usageProtocol &&
      upstreamResponse.headers.get('content-type')?.includes('text/event-stream')
        ? new SseUsageParser(input.usageProtocol)
        : null;
    if (upstreamResponse.body) {
      for await (const chunk of upstreamResponse.body) {
        const observedAt = input.now();
        requestTelemetry.bodyChunks += 1;
        requestTelemetry.responseBytes += chunk.byteLength;
        requestTelemetry.firstBodyChunkMs ??= elapsedMs(startedAt, observedAt);
        if (requestTelemetry.lastBodyChunkAt !== undefined) {
          requestTelemetry.maxBodyChunkGapMs = Math.max(
            requestTelemetry.maxBodyChunkGapMs ?? 0,
            elapsedMs(requestTelemetry.lastBodyChunkAt, observedAt),
          );
        }
        requestTelemetry.lastBodyChunkAt = observedAt;
        const observation = responseUsage?.push(chunk);
        if (observation?.output) {
          requestTelemetry.firstOutputTokenMs ??= elapsedMs(startedAt, observedAt);
          requestTelemetry.lastOutputTokenMs = elapsedMs(startedAt, observedAt);
        }
        if (observation?.reasoning) {
          requestTelemetry.firstReasoningTokenMs ??= elapsedMs(startedAt, observedAt);
          requestTelemetry.lastReasoningTokenMs = elapsedMs(startedAt, observedAt);
        }
        if (
          observation?.output &&
          !observation.reasoning &&
          requestTelemetry.firstReasoningTokenMs !== undefined &&
          requestTelemetry.reasoningEndMs === undefined
        ) {
          requestTelemetry.reasoningEndMs = elapsedMs(startedAt, observedAt);
        }
        input.response.write(chunk);
      }
    }
    const parsed = responseUsage?.finish() ?? null;
    if (upstreamResponse.ok && parsed?.usage) input.usage.add(parsed.usage);
    requestTelemetry.usage = parsed?.usage ?? undefined;
    requestTelemetry.terminalEvent = parsed?.terminalEvent ?? false;
    requestTelemetry.outcome = !upstreamResponse.ok
      ? 'failed'
      : responseUsage && !parsed?.terminalEvent
        ? 'interrupted'
        : 'completed';
    requestTelemetry.durationMs = elapsedMs(startedAt, input.now());
    input.telemetry.finish(requestTelemetry);
    requestTelemetry = null;
    input.response.end();
  } catch (error) {
    if (requestTelemetry) {
      requestTelemetry.outcome = input.signal.aborted ? 'aborted' : 'failed';
      requestTelemetry.durationMs = elapsedMs(requestTelemetry.startedAt, input.now());
      requestTelemetry.errorClass = error instanceof Error ? error.name : 'UnknownError';
      input.telemetry.finish(requestTelemetry);
    }
    if (input.response.destroyed) return;
    if (!input.response.headersSent) input.response.writeHead(502);
    input.response.end('provider proxy request failed');
  }
}

/** Stamp `upstreamStartMs` when the dispatcher begins writing the request to
 * an upstream connection, so connection-queue time is separable from upstream
 * wait in the recorded telemetry. */
function upstreamStartTimedDispatcher(
  dispatcher: Dispatcher,
  requestTelemetry: MutableProviderRequestTelemetry,
  startedAt: number,
  now: () => number,
): Dispatcher {
  return dispatcher.compose((dispatch) => (options, handler) => {
    const timed: Dispatcher.DispatchHandler = Object.create(handler);
    timed.onRequestStart = function (controller, context) {
      requestTelemetry.upstreamStartMs ??= elapsedMs(startedAt, now());
      // Keep `this` = the wrapper for the delegated call too, so handler state
      // written across callbacks always lands on one object.
      return handler.onRequestStart?.call(this, controller, context);
    };
    return dispatch(options, timed);
  });
}

async function resolveUpstreamCredentialUntilAborted(
  resolveUpstreamCredential: ProviderUpstreamCredentialResolver,
  signal: AbortSignal,
): Promise<ProviderUpstreamCredential> {
  if (signal.aborted) throw signal.reason ?? new Error('provider proxy request aborted');
  let rejectOnAbort!: (reason?: unknown) => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectOnAbort = reject;
  });
  const onAbort = () => rejectOnAbort(signal.reason ?? new Error('provider proxy request aborted'));
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    return await Promise.race([resolveUpstreamCredential(signal), aborted]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

function normalizeProxyBasePath(pathname: string): string {
  return pathname === '/' ? '' : pathname.replace(/\/+$/, '');
}

function pathIsWithinBasePath(pathname: string, basePath: string): boolean {
  return basePath === '' || pathname === basePath || pathname.startsWith(`${basePath}/`);
}

class ProviderUsageAccumulator {
  private readonly total: ProviderTokenUsage = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
  private sawUsage = false;
  private sawReasoning = false;

  add(usage: ProviderTokenUsage | null): void {
    if (!usage) return;
    this.sawUsage = true;
    this.total.input += usage.input;
    this.total.cacheRead += usage.cacheRead;
    this.total.cacheWrite += usage.cacheWrite;
    this.total.output += usage.output;
    if (usage.reasoning !== undefined) {
      this.sawReasoning = true;
      this.total.reasoning = (this.total.reasoning ?? 0) + usage.reasoning;
    }
  }

  snapshot(): ProviderTokenUsage | null {
    if (!this.sawUsage) return null;
    const snapshot = { ...this.total };
    if (!this.sawReasoning) delete snapshot.reasoning;
    return snapshot;
  }
}

interface MutableProviderRequestTelemetry extends ProviderRequestTelemetry {
  startedAt: number;
  lastBodyChunkAt?: number;
}

class ProviderTelemetryAccumulator {
  private nextRequestId = 1;
  private readonly requests: ProviderRequestTelemetry[] = [];

  start(
    input: Pick<MutableProviderRequestTelemetry, 'method' | 'path' | 'protocol' | 'startedAt'>,
  ): MutableProviderRequestTelemetry {
    return {
      requestId: this.nextRequestId++,
      method: input.method,
      path: input.path,
      ...(input.protocol ? { protocol: input.protocol } : {}),
      startedAt: input.startedAt,
      outcome: 'failed',
      durationMs: 0,
      bodyChunks: 0,
      responseBytes: 0,
      terminalEvent: false,
    };
  }

  finish(request: MutableProviderRequestTelemetry): void {
    const { startedAt: _startedAt, lastBodyChunkAt: _lastBodyChunkAt, ...snapshot } = request;
    this.requests.push(snapshot);
  }

  snapshot(): ProviderRequestTelemetry[] {
    return this.requests.map((request) => ({
      ...request,
      ...(request.usage ? { usage: { ...request.usage } } : {}),
    }));
  }
}

class SseUsageParser {
  private readonly decoder = new TextDecoder();
  private buffer = '';
  private readonly usage: ProviderTokenUsage = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
  private sawUsage = false;
  private terminalEvent = false;

  constructor(private readonly protocol: ProviderUsageProtocol) {}

  push(chunk: Uint8Array): SseChunkObservation {
    this.buffer += this.decoder.decode(chunk, { stream: true });
    return this.consumeCompleteLines();
  }

  finish(): { usage: ProviderTokenUsage | null; terminalEvent: boolean } {
    this.buffer += this.decoder.decode();
    this.consumeCompleteLines(true);
    return {
      usage: this.sawUsage ? { ...this.usage } : null,
      terminalEvent: this.terminalEvent,
    };
  }

  private consumeCompleteLines(flush = false): SseChunkObservation {
    const observation: SseChunkObservation = { output: false, reasoning: false };
    const lines = this.buffer.split(/\r?\n/);
    this.buffer = flush ? '' : (lines.pop() ?? '');
    for (const line of lines) {
      if (!line.startsWith('data:')) continue;
      const raw = line.slice('data:'.length).trim();
      if (!raw) continue;
      if (raw === '[DONE]') {
        if (this.protocol === 'openai-chat-sse') this.terminalEvent = true;
        continue;
      }
      let event: unknown;
      try {
        event = JSON.parse(raw);
      } catch {
        continue;
      }
      if (!isRecord(event)) continue;
      if (this.protocol === 'anthropic-sse' && event.type === 'message_stop')
        this.terminalEvent = true;
      if (this.protocol === 'openai-responses-sse' && event.type === 'response.completed')
        this.terminalEvent = true;
      const generated = generatedDelta(this.protocol, event);
      observation.output ||= generated.output;
      observation.reasoning ||= generated.reasoning;
      const usage = usageFromEvent(this.protocol, event);
      if (!usage) continue;
      this.sawUsage = true;
      this.usage.input = Math.max(this.usage.input, usage.input);
      this.usage.cacheRead = Math.max(this.usage.cacheRead, usage.cacheRead);
      this.usage.cacheWrite = Math.max(this.usage.cacheWrite, usage.cacheWrite);
      this.usage.output = Math.max(this.usage.output, usage.output);
      if (usage.reasoning !== undefined) {
        this.usage.reasoning = Math.max(this.usage.reasoning ?? 0, usage.reasoning);
      }
    }
    return observation;
  }
}

interface SseChunkObservation {
  output: boolean;
  reasoning: boolean;
}

function generatedDelta(
  protocol: ProviderUsageProtocol,
  event: Record<string, unknown>,
): SseChunkObservation {
  if (protocol === 'anthropic-sse') {
    const delta = isRecord(event.delta) ? event.delta : null;
    const reasoning =
      delta?.type === 'thinking_delta' &&
      typeof delta.thinking === 'string' &&
      delta.thinking.length > 0;
    const output =
      reasoning ||
      (delta?.type === 'text_delta' && typeof delta.text === 'string' && delta.text.length > 0) ||
      (delta?.type === 'input_json_delta' &&
        typeof delta.partial_json === 'string' &&
        delta.partial_json.length > 0);
    return { output, reasoning };
  }
  if (protocol === 'openai-responses-sse') {
    const reasoning =
      (event.type === 'response.reasoning_summary_text.delta' ||
        event.type === 'response.reasoning_text.delta') &&
      typeof event.delta === 'string' &&
      event.delta.length > 0;
    const output =
      reasoning ||
      (typeof event.type === 'string' &&
        event.type.startsWith('response.') &&
        event.type.endsWith('.delta') &&
        typeof event.delta === 'string' &&
        event.delta.length > 0);
    return { output, reasoning };
  }
  const choices = Array.isArray(event.choices) ? event.choices : [];
  let output = false;
  let reasoning = false;
  for (const choice of choices) {
    if (!isRecord(choice) || !isRecord(choice.delta)) continue;
    const delta = choice.delta;
    const hasReasoning =
      (typeof delta.reasoning_content === 'string' && delta.reasoning_content.length > 0) ||
      (typeof delta.reasoning === 'string' && delta.reasoning.length > 0);
    reasoning ||= hasReasoning;
    output ||=
      hasReasoning ||
      (typeof delta.content === 'string' && delta.content.length > 0) ||
      (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) ||
      isRecord(delta.function_call);
  }
  return { output, reasoning };
}

function usageFromEvent(
  protocol: ProviderUsageProtocol,
  event: Record<string, unknown>,
): ProviderTokenUsage | null {
  if (protocol === 'anthropic-sse') return anthropicUsage(event);
  if (protocol === 'openai-responses-sse') return openAiResponsesUsage(event);
  return openAiChatUsage(event);
}

function anthropicUsage(event: Record<string, unknown>): ProviderTokenUsage | null {
  const usage = isRecord(event.usage)
    ? event.usage
    : isRecord(event.message) && isRecord(event.message.usage)
      ? event.message.usage
      : null;
  if (
    !usage ||
    !hasAnyNumber(usage, [
      'input_tokens',
      'cache_read_input_tokens',
      'cache_creation_input_tokens',
      'output_tokens',
    ])
  )
    return null;
  const cacheRead = nonNegativeNumber(usage.cache_read_input_tokens);
  const cacheWrite = nonNegativeNumber(usage.cache_creation_input_tokens);
  return {
    input: nonNegativeNumber(usage.input_tokens) + cacheRead + cacheWrite,
    cacheRead,
    cacheWrite,
    output: nonNegativeNumber(usage.output_tokens),
  };
}

function openAiChatUsage(event: Record<string, unknown>): ProviderTokenUsage | null {
  if (!isRecord(event.usage) || !hasAnyNumber(event.usage, ['prompt_tokens', 'completion_tokens']))
    return null;
  const details = isRecord(event.usage.prompt_tokens_details)
    ? event.usage.prompt_tokens_details
    : null;
  const completionDetails = isRecord(event.usage.completion_tokens_details)
    ? event.usage.completion_tokens_details
    : null;
  return {
    input: nonNegativeNumber(event.usage.prompt_tokens),
    cacheRead: nonNegativeNumber(details?.cached_tokens),
    cacheWrite: 0,
    output: nonNegativeNumber(event.usage.completion_tokens),
    ...(hasAnyNumber(completionDetails ?? {}, ['reasoning_tokens'])
      ? { reasoning: nonNegativeNumber(completionDetails?.reasoning_tokens) }
      : {}),
  };
}

function openAiResponsesUsage(event: Record<string, unknown>): ProviderTokenUsage | null {
  const usage =
    isRecord(event.response) && isRecord(event.response.usage)
      ? event.response.usage
      : isRecord(event.usage)
        ? event.usage
        : null;
  if (!usage || !hasAnyNumber(usage, ['input_tokens', 'output_tokens'])) return null;
  const inputDetails = isRecord(usage.input_tokens_details) ? usage.input_tokens_details : null;
  const outputDetails = isRecord(usage.output_tokens_details) ? usage.output_tokens_details : null;
  return {
    input: nonNegativeNumber(usage.input_tokens),
    cacheRead: nonNegativeNumber(inputDetails?.cached_tokens),
    cacheWrite: 0,
    output: nonNegativeNumber(usage.output_tokens),
    ...(hasAnyNumber(outputDetails ?? {}, ['reasoning_tokens'])
      ? { reasoning: nonNegativeNumber(outputDetails?.reasoning_tokens) }
      : {}),
  };
}

function elapsedMs(startedAt: number, finishedAt: number): number {
  return Math.max(0, finishedAt - startedAt);
}

function hasAnyNumber(record: Record<string, unknown>, keys: readonly string[]): boolean {
  return keys.some(
    (key) =>
      typeof record[key] === 'number' &&
      Number.isFinite(record[key]) &&
      (record[key] as number) >= 0,
  );
}

function nonNegativeNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function authorized(
  header: string | string[] | undefined,
  token: string,
  authMode: ProviderAuthProxyMode,
): boolean {
  if (typeof header !== 'string') return false;
  const value =
    authMode === 'bearer'
      ? header.startsWith('Bearer ')
        ? header.slice('Bearer '.length)
        : undefined
      : header;
  if (value === undefined) return false;
  const presented = Buffer.from(value);
  const expected = Buffer.from(token);
  return presented.length === expected.length && timingSafeEqual(presented, expected);
}

/** Bind the proxy server, translating fixed-port failures via `bindError`.
 * Exported only for the listener-pairing regression test: `once`/`off` must
 * reference the SAME named handler so a successful listen removes it — a
 * post-listen server socket error must then stay loud (uncaughtException),
 * not be swallowed as a rejection of the already-settled bind promise. */
export async function listenProviderAuthProxyServer(
  server: HttpServer,
  listenPort: number,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onBindError = (error: unknown) => {
      reject(listenPort === 0 ? error : bindError(error, listenPort));
    };
    server.once('error', onBindError);
    server.listen(listenPort, '0.0.0.0', () => {
      server.off('error', onBindError);
      resolve();
    });
  });
}

function bindError(error: unknown, port: number): Error {
  const code = (error as { code?: unknown }).code;
  const hint =
    code === 'EACCES'
      ? ` Binding privileged port ${port} was denied — run with the CAP_NET_BIND_SERVICE capability (or as root), lower net.ipv4.ip_unprivileged_port_start, or forward 80/443 to an unprivileged port. Pier's Squid egress for offline tasks only allows destination ports 80/443, so the container-facing proxy must present one of those.`
      : code === 'EADDRINUSE'
        ? ` Port ${port} is already in use; free it or choose the other of 80/443.`
        : '';
  const bound = new Error(
    `provider auth proxy failed to bind port ${port}: ${error instanceof Error ? error.message : String(error)}.${hint}`,
  );
  if (typeof code === 'string') (bound as Error & { code?: string }).code = code;
  return bound;
}

async function readRequestBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request)
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

const HOP_BY_HOP_HEADERS = new Set([
  'accept-encoding',
  'authorization',
  'connection',
  'content-encoding',
  'content-length',
  'host',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

const REQUEST_HEADER_DENYLIST = new Set([...HOP_BY_HOP_HEADERS, 'x-api-key']);
