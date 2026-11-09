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

import { z } from 'zod';
import type { Manifest } from '../shared/plugin.js';

interface Connection {
  open(signal: AbortSignal): Promise<WebClient>;
  connect(): Promise<void>;
}
let connection: Connection | undefined;
/** Share the desktop's existing OpenCLI installation and Chrome native host. */
export function configureQuickWeb(value: Connection): void {
  connection = value;
}
export interface WebClient {
  call(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown>;
  close(): Promise<void>;
}
export type WebClientFactory = (signal: AbortSignal) => Promise<WebClient>;
async function openClient(signal: AbortSignal): Promise<WebClient> {
  if (!connection) throw Error('Open this plugin in the Maka main application');
  return connection.open(signal);
}
const envelope = z
  .object({
    ok: z.boolean(),
    error: z.object({ message: z.string(), hint: z.string().optional() }).passthrough().optional(),
  })
  .passthrough();
export function unpackWebResult(value: unknown): Record<string, unknown> {
  const reply = z
    .object({
      isError: z.boolean().optional(),
      content: z.array(z.object({ type: z.string(), text: z.string().optional() }).passthrough()),
    })
    .parse(value);
  const text = reply.content.find((item) => item.type === 'text')?.text;
  if (!text || text.length > 1_000_000) throw Error('Invalid OpenCLI response');
  const result = envelope.parse(JSON.parse(text));
  if (reply.isError || !result.ok)
    throw Error(
      [result.error?.message ?? 'OpenCLI command failed', result.error?.hint]
        .filter(Boolean)
        .join('\n'),
    );
  return result;
}
const inputSchema = z
  .object({
    command: z.string().min(1).max(80),
    args: z.record(z.string().max(80), z.unknown()).default({}),
  })
  .strict();
export class WebPlugins {
  private active = new Map<string, AbortController>();
  constructor(private factory: WebClientFactory = openClient) {}
  async connect(): Promise<void> {
    if (!connection) throw Error('Open this plugin in the Maka main application');
    await connection.connect();
  }
  async run(manifest: Manifest, input: unknown, valid: () => boolean) {
    const value = inputSchema.parse(input);
    if (JSON.stringify(value.args).length > 16000) throw Error('Web command input is too large');
    const declaration = manifest.web?.commands.find((command) => command.id === value.command);
    if (!manifest.permissions.includes('web.run') || !declaration)
      throw Error('Web command is not declared by this plugin');
    if (declaration.access !== 'read') throw Error('This version supports read-only web commands');
    if (!valid()) throw Error('Web command cancelled');
    if (this.active.has(manifest.id)) throw Error('A web command is already running');
    const abort = new AbortController();
    this.active.set(manifest.id, abort);
    const timer = setTimeout(() => abort.abort(Error('Web command timed out; try again')), 25000);
    let client: WebClient | undefined;
    const current = () => {
      abort.signal.throwIfAborted();
      if (!valid()) throw Error('Web command cancelled');
    };
    try {
      client = await this.factory(abort.signal);
      current();
      if (declaration.request) {
        // Fixed GET endpoints only: plugins cannot supply browser code, headers, or arbitrary URLs.
        const request = declaration.request,
          url = new URL(request.path, request.origin);
        if (
          url.origin !== request.origin ||
          url.protocol !== 'https:' ||
          !(url.hostname === declaration.domain || url.hostname.endsWith('.' + declaration.domain))
        )
          throw Error('Invalid web request domain');
        for (const [key, item] of Object.entries(value.args)) {
          if (
            !request.params.includes(key) ||
            !['string', 'number', 'boolean'].includes(typeof item)
          )
            throw Error('Invalid web request parameter');
          url.searchParams.set(key, String(item));
        }
        const code = `(async () => { const tab = await browser.tabs.new(${JSON.stringify('https://' + declaration.domain + '/')}); try { return await tab.fetchJson(${JSON.stringify(url.href)}, { method: 'GET' }); } finally { await tab.close(); } })()`;
        const result = unpackWebResult(
          await client.call('js', { code, timeoutMs: 20000, maxChars: 120000 }, abort.signal),
        );
        current();
        return { rows: [], value: result.value };
      }
      // Check the live adapter contract, including local user overrides, before running it.
      const catalog = unpackWebResult(
        await client.call(
          'sites_search',
          { query: `${declaration.site} ${declaration.command}`, limit: 100 },
          abort.signal,
        ),
      );
      const commands = z
        .array(
          z
            .object({
              site: z.string(),
              name: z.string(),
              access: z.string(),
              domain: z.string().optional(),
            })
            .passthrough(),
        )
        .parse(catalog.results);
      const command = commands.find(
        (c) => c.site === declaration.site && c.name === declaration.command,
      );
      if (
        !command ||
        command.access !== declaration.access ||
        command.domain !== declaration.domain
      )
        throw Error(
          'The OpenCLI adapter is unavailable or its access/domain changed. Review the plugin before retrying.',
        );
      current();
      const result = unpackWebResult(
        await client.call(
          'site_run',
          { site: declaration.site, command: declaration.command, args: value.args },
          abort.signal,
        ),
      );
      current();
      return {
        rows: Array.isArray(result.rows) ? result.rows.slice(0, 200) : [],
        value: result.value,
      };
    } finally {
      clearTimeout(timer);
      if (this.active.get(manifest.id) === abort) this.active.delete(manifest.id);
      await client?.close().catch(() => {});
    }
  }
  cancel(id?: string): void {
    for (const [key, abort] of this.active)
      if (!id || key === id) abort.abort(Error('Web command cancelled'));
  }
}
