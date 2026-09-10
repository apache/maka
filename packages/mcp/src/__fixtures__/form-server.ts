/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { CallToolResult, ElicitResult, Tool } from '@modelcontextprotocol/client';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler, inputRequired, Server } from '@modelcontextprotocol/server';

export interface McpFormWireCall {
  id: string | number;
  params: {
    name: string;
    arguments?: Record<string, unknown>;
    _meta?: Record<string, unknown>;
    inputResponses?: Record<string, ElicitResult>;
    requestState?: string;
  };
}

type FormServerResult = CallToolResult | ReturnType<typeof inputRequired>;

export interface McpFormFixture {
  url: string;
  calls: McpFormWireCall[];
  callHeaders: IncomingHttpHeaders[];
  initializeCapabilities?: unknown;
  definition: Tool;
  respond(params: McpFormWireCall['params']): FormServerResult | Promise<FormServerResult>;
  close(): Promise<void>;
}

/** Real modern-only server, with wire capture before the SDK dispatches it. */
export async function createMcpFormFixture(
  options: { legacy?: boolean } = {},
): Promise<McpFormFixture> {
  const errors: unknown[] = [];
  const handler = createMcpHandler(
    () => {
      const server = new Server(
        { name: 'form-fixture', version: '1' },
        {
          capabilities: { tools: {} },
        },
      );
      server.setRequestHandler('tools/list', async () => ({ tools: [fixture.definition] }));
      server.setRequestHandler('tools/call', async ({ params }, context) =>
        fixture.respond({
          ...params,
          ...(context.mcpReq.inputResponses === undefined
            ? {}
            : { inputResponses: context.mcpReq.inputResponses as Record<string, ElicitResult> }),
          ...(context.mcpReq.requestState() === undefined
            ? {}
            : { requestState: context.mcpReq.requestState() }),
        }),
      );
      return server;
    },
    {
      legacy: options.legacy ? 'stateless' : 'reject',
      keepAliveMs: 0,
      onerror: (error) => errors.push(error),
    },
  );
  const handle = toNodeHandler(handler, { onerror: (error) => errors.push(error) });
  const server = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const text = Buffer.concat(chunks).toString('utf8');
      const body = text ? JSON.parse(text) : undefined;
      for (const message of Array.isArray(body) ? body : [body]) {
        if (message?.method === 'initialize')
          fixture.initializeCapabilities = message.params?.capabilities;
        if (message?.method === 'tools/call') {
          fixture.calls.push(structuredClone(message));
          fixture.callHeaders.push({ ...req.headers });
        }
      }
      await handle(req, res, body);
    } catch (error) {
      errors.push(error);
      if (!res.headersSent) res.writeHead(500);
      res.end();
    }
  });
  const fixture: McpFormFixture = {
    url: '',
    calls: [],
    callHeaders: [],
    definition: { name: 'ask_user', inputSchema: { type: 'object' } },
    respond: (params) =>
      params.inputResponses
        ? { content: [{ type: 'text', text: 'complete' }] }
        : inputRequired({
            inputRequests: { form: mcpFixtureFormRequest() },
            requestState: 'opaque-state',
          }),
    close: async () => {
      await handler.close();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      if (errors.length) throw new AggregateError(errors, 'MCP form fixture failed');
    },
  };
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('MCP form fixture has no address');
  fixture.url = `http://127.0.0.1:${address.port}/mcp`;
  return fixture;
}

export function mcpFixtureFormRequest() {
  return {
    method: 'elicitation/create' as const,
    params: {
      mode: 'form' as const,
      message: 'Please confirm your details',
      requestedSchema: {
        type: 'object' as const,
        properties: {
          name: { type: 'string' as const },
          email: { type: 'string' as const, format: 'email' as const },
          confirm: { type: 'boolean' as const },
        },
        required: ['name', 'email', 'confirm'],
      },
    },
  };
}
