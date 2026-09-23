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

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

export type CuaDriverServiceState = 'idle' | 'starting' | 'ready' | 'unavailable' | 'disposed';

export interface CuaDriverResult {
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
  content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
}

/** The stdio child is private to Maka. Its tools are never registered as agent tools. */
export class CuaDriverService {
  private client?: Client;
  private opening?: Promise<Client>;
  private state: CuaDriverServiceState = 'idle';
  private generation = 0;

  constructor(
    private readonly binaryPath: string,
    private readonly expectedBinarySha256: string,
    private readonly onUnexpectedClose?: () => void,
  ) {}

  snapshot(): { state: CuaDriverServiceState; generation: number } {
    return { state: this.state, generation: this.generation };
  }

  private async open(): Promise<Client> {
    if (this.state === 'disposed') throw new Error('Cua Driver service is disposed');
    if (this.client) return this.client;
    if (this.opening) return this.opening;
    this.state = 'starting';
    this.opening = (async () => {
      const actualSha256 = createHash('sha256')
        .update(await readFile(this.binaryPath))
        .digest('hex');
      if (actualSha256 !== this.expectedBinarySha256) {
        this.state = 'unavailable';
        throw new Error('Cua Driver binary no longer matches its pinned digest');
      }
      if (this.state === 'disposed')
        throw new Error('Cua Driver service was disposed during startup');
      const transport = new StdioClientTransport({
        command: this.binaryPath,
        args: [
          'mcp',
          '--direct',
          '--embedded',
          '--no-overlay',
          '--host-bundle-id',
          'com.maka.desktop',
        ],
        env: {
          ...process.env,
          CUA_DRIVER_RS_TELEMETRY_ENABLED: 'false',
          CUA_TELEMETRY_ENABLED: 'false',
          CUA_DRIVER_RS_UPDATE_CHECK: 'false',
        },
        stderr: 'ignore',
      });
      const client = new Client(
        { name: 'maka-computer-use', version: '0.1.0' },
        {
          capabilities: {},
        },
      );
      client.onclose = () => {
        if (this.client !== client) return;
        this.client = undefined;
        this.generation += 1;
        if (this.state !== 'disposed') {
          this.state = 'unavailable';
          this.onUnexpectedClose?.();
        }
      };
      try {
        await client.connect(transport, { timeout: 10_000 });
      } catch (error) {
        this.state = 'unavailable';
        await client.close().catch(() => {});
        throw error;
      }
      if (this.snapshot().state === 'disposed') {
        await client.close();
        throw new Error('Cua Driver service was disposed during startup');
      }
      this.client = client;
      this.state = 'ready';
      this.generation += 1;
      return client;
    })();
    try {
      return await this.opening;
    } catch (error) {
      if (this.snapshot().state !== 'disposed') this.state = 'unavailable';
      throw error;
    } finally {
      this.opening = undefined;
    }
  }

  async call(
    name: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<CuaDriverResult> {
    if (signal.aborted) throw signal.reason ?? new Error('Cua Driver call aborted');
    const client = await this.open();
    return client.callTool(
      { name, arguments: args },
      { signal, timeout: 25_000 },
    ) as Promise<CuaDriverResult>;
  }

  async dispose(): Promise<void> {
    this.state = 'disposed';
    const client = this.client;
    this.client = undefined;
    await client?.close().catch(() => {});
  }
}
