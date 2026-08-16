import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https';
import type { Duplex } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { WebSocketServer } from 'ws';
import { RUNTIME_HOST_MAX_MESSAGE_BYTES } from '../protocol/index.js';
import { WebSocketTransport } from '../transport/websocket-transport.js';
import type { RuntimeHostAccessAuthority } from './access-authority.js';
import type { RuntimeHostListener, RuntimeHostListenerConnection } from './listener-set.js';

const DEFAULT_WEBSOCKET_PATH = '/runtime-host';
const MAX_WEBSOCKET_FRAGMENTS = 256;
const MAX_WEBSOCKET_BUFFERED_CHUNKS = 256;

export interface RuntimeHostWebSocketTls {
  readonly certificate: string | Buffer;
  readonly privateKey: string | Buffer;
}

export interface StartRuntimeHostWebSocketListenerOptions {
  readonly host: string;
  readonly port: number;
  readonly path?: string;
  readonly tls?: RuntimeHostWebSocketTls;
  readonly allowInsecureRemote?: boolean;
  readonly allowedOrigins?: readonly string[];
  readonly accessAuthority: RuntimeHostAccessAuthority;
  readonly isReady: () => boolean;
  readonly accept: (connection: RuntimeHostListenerConnection) => void;
}

export async function startRuntimeHostWebSocketListener(
  options: StartRuntimeHostWebSocketListenerOptions,
): Promise<RuntimeHostListener & { readonly kind: 'websocket' }> {
  validateWebSocketListenerOptions(options);
  const path = options.path ?? DEFAULT_WEBSOCKET_PATH;
  const server = options.tls
    ? createHttpsServer(
        { cert: options.tls.certificate, key: options.tls.privateKey },
        (request, response) => handleHttpRequest(request, response, options.isReady),
      )
    : createHttpServer((request, response) =>
        handleHttpRequest(request, response, options.isReady),
      );
  const webSocketOptions = {
    noServer: true,
    clientTracking: true,
    maxPayload: RUNTIME_HOST_MAX_MESSAGE_BYTES,
    maxFragments: MAX_WEBSOCKET_FRAGMENTS,
    maxBufferedChunks: MAX_WEBSOCKET_BUFFERED_CHUNKS,
    perMessageDeflate: false,
  };
  const webSocketServer = new WebSocketServer(webSocketOptions);
  const transports = new Set<WebSocketTransport>();
  const onUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (!upgradeTargetsPath(request, path)) {
      rejectUpgrade(socket, 404, 'Not Found');
      return;
    }
    if (!originAccepted(request.headers.origin, options.allowedOrigins)) {
      rejectUpgrade(socket, 403, 'Forbidden');
      return;
    }
    const credential = readBearerCredential(request.headers.authorization);
    if (!credential || !options.accessAuthority.authenticate(credential)) {
      rejectUpgrade(socket, 401, 'Unauthorized');
      return;
    }
    webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
      const authority = options.accessAuthority.authenticate(credential);
      if (!authority) {
        webSocket.terminate();
        return;
      }
      const transport = new WebSocketTransport(webSocket);
      transports.add(transport);
      void transport.closed.then(() => transports.delete(transport));
      try {
        options.accept({ transport, authority });
      } catch (error) {
        transport.abort(asError(error));
      }
    });
  };
  server.on('upgrade', onUpgrade);
  try {
    await listen(server, options.host, options.port);
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('WebSocket listener has no address');
    const scheme = options.tls ? 'wss' : 'ws';
    const host = address.family === 'IPv6' ? `[${address.address}]` : address.address;
    return new RuntimeHostWebSocketListener(
      server,
      webSocketServer,
      transports,
      `${scheme}://${host}:${address.port}${path}`,
      onUpgrade,
    );
  } catch (error) {
    server.off('upgrade', onUpgrade);
    for (const transport of transports) transport.abort();
    await closeWebSocketServer(webSocketServer).catch(() => undefined);
    await closeServer(server).catch(() => undefined);
    throw error;
  }
}

class RuntimeHostWebSocketListener implements RuntimeHostListener {
  readonly kind = 'websocket' as const;
  readonly endpoint: string;
  readonly #server: HttpServer | HttpsServer;
  readonly #webSocketServer: WebSocketServer;
  readonly #transports: Set<WebSocketTransport>;
  readonly #onUpgrade: (request: IncomingMessage, socket: Duplex, head: Buffer) => void;
  #closeTask: Promise<void> | undefined;
  #serverCloseTask: Promise<void> | undefined;
  #cleanupTask: Promise<void> | undefined;

  constructor(
    server: HttpServer | HttpsServer,
    webSocketServer: WebSocketServer,
    transports: Set<WebSocketTransport>,
    endpoint: string,
    onUpgrade: (request: IncomingMessage, socket: Duplex, head: Buffer) => void,
  ) {
    this.#server = server;
    this.#webSocketServer = webSocketServer;
    this.#transports = transports;
    this.endpoint = endpoint;
    this.#onUpgrade = onUpgrade;
  }

  closeAdmission(): Promise<void> {
    if (!this.#closeTask) {
      this.#server.off('upgrade', this.#onUpgrade);
      this.#serverCloseTask = closeServer(this.#server);
      void this.#serverCloseTask.catch(() => undefined);
      this.#server.closeAllConnections();
      this.#closeTask = Promise.resolve();
    }
    return this.#closeTask;
  }

  cleanup(): Promise<void> {
    this.#cleanupTask ??= (async () => {
      await this.closeAdmission();
      for (const transport of this.#transports) transport.abort();
      await closeWebSocketServer(this.#webSocketServer);
      await this.#serverCloseTask;
    })();
    return this.#cleanupTask;
  }
}

function handleHttpRequest(
  request: IncomingMessage,
  response: ServerResponse,
  isReady: () => boolean,
): void {
  if (request.method !== 'GET') {
    respond(response, 405, 'Method Not Allowed');
    return;
  }
  const pathname = request.url ? new URL(request.url, 'http://runtime-host.invalid').pathname : '';
  if (pathname === '/healthz') {
    respond(response, 200, 'ok');
    return;
  }
  if (pathname === '/readyz') {
    const ready = isReady();
    respond(response, ready ? 200 : 503, ready ? 'ready' : 'not ready');
    return;
  }
  respond(response, 404, 'Not Found');
}

function respond(response: ServerResponse, status: number, body: string): void {
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'text/plain; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  response.end(body);
}

function upgradeTargetsPath(request: IncomingMessage, expectedPath: string): boolean {
  if (request.method !== 'GET' || !request.url) return false;
  const url = new URL(request.url, 'http://runtime-host.invalid');
  return url.pathname === expectedPath && url.search === '';
}

function originAccepted(origin: string | undefined, allowedOrigins: readonly string[] | undefined) {
  if (origin === undefined) return true;
  return allowedOrigins?.includes(origin) === true;
}

function readBearerCredential(value: string | undefined): string | undefined {
  if (!value?.startsWith('Bearer ')) return;
  const credential = value.slice('Bearer '.length);
  return credential.length > 0 && !/\s/u.test(credential) ? credential : undefined;
}

function rejectUpgrade(socket: Duplex, status: number, message: string): void {
  if (socket.destroyed) return;
  socket.end(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

function validateWebSocketListenerOptions(options: StartRuntimeHostWebSocketListenerOptions): void {
  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65_535) {
    throw new RangeError('Runtime Host WebSocket port must be between 0 and 65535');
  }
  const path = options.path ?? DEFAULT_WEBSOCKET_PATH;
  if (!path.startsWith('/') || path.includes('?') || path.includes('#')) {
    throw new Error('Runtime Host WebSocket path must be an absolute URL path');
  }
  if (options.tls && options.allowInsecureRemote === true) {
    throw new Error('Insecure Runtime Host listener opt-in cannot be combined with TLS');
  }
  if (
    !options.tls &&
    options.allowInsecureRemote !== true &&
    options.host !== '127.0.0.1' &&
    options.host !== '::1'
  ) {
    throw new Error('Plain Runtime Host WebSocket listeners must bind to loopback');
  }
  if (
    options.allowedOrigins &&
    new Set(options.allowedOrigins).size !== options.allowedOrigins.length
  ) {
    throw new Error('Runtime Host WebSocket Origin allowlist contains duplicates');
  }
}

function listen(server: HttpServer | HttpsServer, host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

function closeServer(server: HttpServer | HttpsServer): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function closeWebSocketServer(server: WebSocketServer): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
