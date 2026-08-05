import assert from 'node:assert/strict';
import { createServer, type IncomingMessage } from 'node:http';
import { connect as connectTcp, type AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { afterEach, describe, test } from 'node:test';
import WebSocket, { WebSocketServer } from 'ws';

import {
  createOpenAiResponsesTransportState,
  OPENAI_RESPONSES_LANE_HEADER,
  webSocketProxyAgent,
} from '../openai-responses-websocket.js';
import { createProxiedFetchTransport } from '../network/scoped-fetch-transport.js';

const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(disposers.splice(0).map((dispose) => dispose()));
});

describe('OpenAI Responses WebSocket transport', () => {
  test('reuses a turn socket and sends previous_response_id with delta-only input', async () => {
    const requests: Record<string, unknown>[] = [];
    const server = await websocketServer((socket) => {
      socket.on('message', (data) => {
        const body = JSON.parse(data.toString()) as Record<string, unknown>;
        requests.push(body);
        const index = requests.length;
        socket.send(
          JSON.stringify({
            type: 'response.created',
            response: { id: `resp-${index}`, created_at: 1, model: 'gpt-test' },
          }),
        );
        socket.send(
          JSON.stringify({
            type: 'response.completed',
            response: {
              id: `resp-${index}`,
              output: [{ type: 'message', id: `msg-${index}`, content: [] }],
            },
          }),
        );
      });
    });
    const state = createOpenAiResponsesTransportState();
    disposers.push(async () => state.close());
    const fetch = state.wrapFetch(globalThis.fetch);

    await consume(
      await fetch(server.url, request('turn-1', { model: 'gpt-test', input: [{ role: 'user' }] })),
    );
    await consume(
      await fetch(
        server.url,
        request('turn-1', {
          model: 'gpt-test',
          input: [{ type: 'function_call_output', call_id: 'call-1', output: 'ok' }],
          previous_response_id: 'resp-1',
        }),
      ),
    );

    assert.equal(server.connections(), 1);
    assert.deepEqual(requests[0], {
      type: 'response.create',
      model: 'gpt-test',
      input: [{ role: 'user' }],
    });
    assert.deepEqual(requests[1], {
      type: 'response.create',
      model: 'gpt-test',
      input: [{ type: 'function_call_output', call_id: 'call-1', output: 'ok' }],
      previous_response_id: 'resp-1',
    });
  });

  test('reconstructs the complete history for HTTP when WebSocket setup fails', async () => {
    const httpBodies: Record<string, unknown>[] = [];
    const httpFetch: typeof globalThis.fetch = async (_input, init) => {
      httpBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response('http', { status: 200 });
    };
    const state = createOpenAiResponsesTransportState({ webSocketUrl: 'ws://127.0.0.1:1' });
    disposers.push(async () => state.close());
    const fetch = state.wrapFetch(httpFetch);

    const response = await fetch(
      'https://api.openai.com/v1/responses',
      request('turn-1', { model: 'gpt-test', input: [{ role: 'user' }] }),
    );

    assert.equal(await response.text(), 'http');
    assert.deepEqual(httpBodies, [{ model: 'gpt-test', stream: true, input: [{ role: 'user' }] }]);
    assert.equal(state.canRecordSemantic('turn-1', 'resp-any'), false);
  });

  test('uses the HTTP/SOCKS proxy snapshot and honors the same bypass list', () => {
    const httpTransport = createProxiedFetchTransport({
      enabled: true,
      type: 'http',
      host: 'proxy.local',
      port: 8080,
      username: 'user',
      password: 'secret',
      bypassList: ['bypass.test'],
    });
    const socksTransport = createProxiedFetchTransport({
      enabled: true,
      type: 'socks5',
      host: '127.0.0.1',
      port: 1080,
      bypassList: [],
    });
    disposers.push(httpTransport.close, socksTransport.close);

    assert.equal(
      webSocketProxyAgent(httpTransport.fetch, 'https://api.openai.com/v1/responses')?.constructor
        .name,
      'HttpsProxyAgent',
    );
    assert.equal(
      webSocketProxyAgent(httpTransport.fetch, 'https://bypass.test/v1/responses'),
      undefined,
    );
    assert.equal(
      webSocketProxyAgent(socksTransport.fetch, 'https://api.openai.com/v1/responses')?.constructor
        .name,
      'SocksProxyAgent',
    );
  });

  test('connects through the configured authenticated HTTP proxy', async () => {
    const target = await websocketServer((socket) => {
      socket.once('message', () => {
        socket.send(
          JSON.stringify({
            type: 'response.completed',
            response: { id: 'resp-proxied', output: [] },
          }),
        );
      });
    });
    const proxy = await connectProxyServer();
    const state = createOpenAiResponsesTransportState();
    disposers.push(async () => state.close());
    const transport = createProxiedFetchTransport({
      enabled: true,
      type: 'http',
      host: '127.0.0.1',
      port: proxy.port,
      username: 'proxy-user',
      password: 'proxy-secret',
      bypassList: [],
    });
    disposers.push(transport.close);
    const fetch = state.wrapFetch(transport.fetch);

    await consume(
      await fetch(target.url, request('turn-1', { model: 'gpt-test', input: [{ role: 'user' }] })),
    );

    assert.equal(proxy.connections(), 1);
    assert.equal(target.connections(), 1);
    assert.equal(
      proxy.authorization(),
      `Basic ${Buffer.from('proxy-user:proxy-secret').toString('base64')}`,
    );
  });

  test('reconnects with complete history instead of using a socket-local id', async () => {
    const requests: Record<string, unknown>[] = [];
    const server = await websocketServer((socket) => {
      socket.once('message', (data) => {
        requests.push(JSON.parse(data.toString()) as Record<string, unknown>);
        socket.send(
          JSON.stringify({
            type: 'response.completed',
            response: {
              id: `resp-${requests.length}`,
              output: [{ type: 'function_call', call_id: 'call-1', name: 'shell' }],
            },
          }),
        );
        socket.close();
      });
    });
    const state = createOpenAiResponsesTransportState();
    disposers.push(async () => state.close());
    const fetch = state.wrapFetch(globalThis.fetch);

    await consume(
      await fetch(server.url, request('turn-1', { model: 'gpt-test', input: [{ role: 'user' }] })),
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    await consume(
      await fetch(
        server.url,
        request('turn-1', {
          model: 'gpt-test',
          input: [{ type: 'function_call_output', call_id: 'call-1', output: 'ok' }],
          previous_response_id: 'resp-1',
        }),
      ),
    );

    assert.equal(server.connections(), 2);
    assert.deepEqual(requests[1], {
      type: 'response.create',
      model: 'gpt-test',
      input: [
        { role: 'user' },
        { type: 'function_call', call_id: 'call-1', name: 'shell' },
        { type: 'function_call_output', call_id: 'call-1', output: 'ok' },
      ],
    });
  });

  test('reconstructs prior input, provider output, and the delta when a reused lane falls back', async () => {
    const httpBodies: Record<string, unknown>[] = [];
    const server = await websocketServer((socket) => {
      socket.once('message', () => {
        socket.send(
          JSON.stringify({
            type: 'response.completed',
            response: {
              id: 'resp-1',
              output: [{ type: 'function_call', call_id: 'call-1', name: 'shell' }],
            },
          }),
        );
      });
    });
    const state = createOpenAiResponsesTransportState({ connectTimeoutMs: 100 });
    disposers.push(async () => state.close());
    const fetch = state.wrapFetch(async (_input, init) => {
      httpBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response('http', { status: 200 });
    });

    await consume(
      await fetch(server.url, request('turn-1', { model: 'gpt-test', input: [{ role: 'user' }] })),
    );
    await server.stopWebSockets();
    await new Promise((resolve) => setTimeout(resolve, 10));
    const response = await fetch(
      server.url,
      request('turn-1', {
        model: 'gpt-test',
        input: [{ type: 'function_call_output', call_id: 'call-1', output: 'ok' }],
        previous_response_id: 'resp-1',
      }),
    );

    assert.equal(await response.text(), 'http');
    assert.deepEqual(httpBodies, [
      {
        model: 'gpt-test',
        stream: true,
        input: [
          { role: 'user' },
          { type: 'function_call', call_id: 'call-1', name: 'shell' },
          { type: 'function_call_output', call_id: 'call-1', output: 'ok' },
        ],
      },
    ]);
  });
});

function request(lane: string, body: Record<string, unknown>): RequestInit {
  return {
    method: 'POST',
    headers: {
      authorization: 'Bearer test',
      'content-type': 'application/json',
      [OPENAI_RESPONSES_LANE_HEADER]: lane,
    },
    body: JSON.stringify({ ...body, stream: true }),
  };
}

async function consume(response: Response): Promise<string> {
  return await response.text();
}

async function websocketServer(
  onConnection: (socket: WebSocket, request: IncomingMessage) => void,
) {
  const http = createServer();
  const sockets = new Set<WebSocket>();
  const ws = new WebSocketServer({ server: http });
  let connections = 0;
  ws.on('connection', (socket, request) => {
    connections += 1;
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    onConnection(socket, request);
  });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const address = http.address() as AddressInfo;
  const url = `http://127.0.0.1:${address.port}/v1/responses`;
  let webSocketsStopped = false;
  const stopWebSockets = async () => {
    if (webSocketsStopped) return;
    webSocketsStopped = true;
    for (const socket of sockets) socket.terminate();
    await new Promise<void>((resolve) => ws.close(() => resolve()));
  };
  disposers.push(async () => {
    await stopWebSockets();
    await new Promise<void>((resolve) => http.close(() => resolve()));
  });
  return { url, connections: () => connections, stopWebSockets };
}

async function connectProxyServer() {
  const server = createServer();
  const sockets = new Set<Duplex>();
  let connections = 0;
  let authorization: string | undefined;
  server.on('connect', (request, client, head) => {
    connections += 1;
    authorization = request.headers['proxy-authorization'];
    const [host, rawPort] = (request.url ?? '').split(':');
    const upstream = connectTcp(Number(rawPort), host);
    sockets.add(client);
    sockets.add(upstream);
    client.on('close', () => sockets.delete(client));
    upstream.on('close', () => sockets.delete(upstream));
    upstream.once('connect', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length > 0) upstream.write(head);
      client.pipe(upstream).pipe(client);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  disposers.push(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return {
    port: address.port,
    connections: () => connections,
    authorization: () => authorization,
  };
}
