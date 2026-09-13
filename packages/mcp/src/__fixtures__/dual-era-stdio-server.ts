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

import { Server } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { installStdioFixtureEvents } from './stdio-fixture-events.js';

const record = installStdioFixtureEvents('dual-era');
const factoryDelayMs = Number(process.env.MAKA_MCP_STDIO_FACTORY_DELAY_MS ?? 0);

serveStdio(
  async ({ era }) => {
    record('factory', { era });
    if (era === 'modern' && Number.isFinite(factoryDelayMs) && factoryDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, factoryDelayMs));
    }
    const server = new Server(
      { name: 'maka-dual-era-stdio-fixture', version: '1.0.0' },
      { capabilities: { tools: {} } },
    );
    server.setRequestHandler('tools/list', async () => ({
      tools: [
        {
          name: 'echo',
          description: 'Echo text',
          inputSchema: {
            type: 'object',
            properties: { value: { type: 'string' } },
          },
        },
      ],
    }));
    server.setRequestHandler('tools/call', async ({ params }) => ({
      content: [{ type: 'text', text: String(params.arguments?.value ?? '') }],
    }));
    return server;
  },
  { legacy: process.argv.includes('--modern-only') ? 'reject' : 'serve' },
);
