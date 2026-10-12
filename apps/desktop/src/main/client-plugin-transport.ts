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

import type { WebContents } from 'electron';
import { createHash, randomUUID } from 'node:crypto';
import type {
  OperationInput,
  OperationOutput,
  PluginClientCompositionEntry,
  PluginClientQueryInput,
  PluginClientQueryResult,
} from '@maka/runtime-host/protocol';
import { PLUGIN_CLIENT_BUNDLE_MAX_BYTES } from '@maka/runtime-host/protocol';
import type { MakaClientPluginSnapshot } from '@maka/ui/client-plugin-runtime';
import { handleReconnectableRead, type ReconnectableReadIpcMain } from './ipc-reconnect-policy.js';

export const MAKA_CLIENT_PLUGIN_SCHEME = 'maka-client-plugin';

type ClientPluginOperation =
  | 'plugin.client.query'
  | 'plugin.client.remote.call'
  | 'plugin.client.remote.stream.open'
  | 'plugin.client.remote.stream.next'
  | 'plugin.client.remote.stream.close';

export interface ClientPluginQueryClient {
  request(
    operation: 'plugin.client.query',
    input: PluginClientQueryInput,
  ): Promise<PluginClientQueryResult>;
}

export interface ClientPluginRemoteClient {
  request<K extends ClientPluginOperation>(
    operation: K,
    input: OperationInput<K>,
  ): Promise<OperationOutput<K>>;
}

type StreamRenderer = Pick<WebContents, 'id' | 'on' | 'once' | 'off'>;
interface StreamOwner {
  epoch: number;
  readonly ids: Set<string>;
  release(): void;
}

interface BundleRoute {
  readonly client: ClientPluginQueryClient;
  readonly entry: PluginClientCompositionEntry;
}

/** Bridges Host-owned, content-addressed Client generations into Electron. */
export class ClientPluginTransport {
  readonly #streamOwners = new Map<ClientPluginRemoteClient, Map<number, StreamOwner>>();
  readonly #routes = new Map<string, BundleRoute>();
  readonly #tokens = new Map<ClientPluginQueryClient, Map<string, string>>();

  async openStream(client: ClientPluginRemoteClient, target: StreamRenderer, input: OperationInput<'plugin.client.remote.stream.open'>) {
    let owners = this.#streamOwners.get(client);
    if (!owners) this.#streamOwners.set(client, owners = new Map());
    let owner = owners.get(target.id);
    if (!owner) {
      const close = () => {
        binding.epoch++;
        for (const streamId of binding.ids) {
          void client.request('plugin.client.remote.stream.close', { streamId }).catch(() => undefined);
        }
        binding.ids.clear();
      };
      const navigate = (_event: unknown, _url: string, inPlace: boolean, mainFrame: boolean) => {
        if (mainFrame && !inPlace) close();
      };
      const binding: StreamOwner = {
        epoch: 0,
        ids: new Set(),
        release: () => {
          close();
          target.off('did-start-navigation', navigate);
          target.off('render-process-gone', close);
          target.off('destroyed', binding.release);
          owners.delete(target.id);
        },
      };
      owner = binding;
      owners.set(target.id, owner);
      target.on('did-start-navigation', navigate);
      target.on('render-process-gone', close);
      target.once('destroyed', binding.release);
    }
    const epoch = owner.epoch;
    const result = await client.request('plugin.client.remote.stream.open', input);
    if (owner.epoch !== epoch) {
      await client.request('plugin.client.remote.stream.close', result).catch(() => undefined);
      // The old document cannot consume this reply. Preserve the wire shape;
      // a late pull is handled as exhausted by the document ownership check.
      return result;
    }
    owner.ids.add(result.streamId);
    return result;
  }

  ownsStream(client: ClientPluginRemoteClient, targetId: number, streamId: string): boolean {
    return this.#streamOwners.get(client)?.get(targetId)?.ids.has(streamId) ?? false;
  }

  forgetStream(client: ClientPluginRemoteClient, streamId: string): void {
    for (const owner of this.#streamOwners.get(client)?.values() ?? []) owner.ids.delete(streamId);
  }

  async snapshot(client: ClientPluginQueryClient): Promise<MakaClientPluginSnapshot> {
    const result = await client.request('plugin.client.query', { kind: 'snapshot' });
    if (result.kind !== 'snapshot') throw new Error('Runtime Host returned a Client bundle page');
    const previous = this.#tokens.get(client) ?? new Map<string, string>();
    const next = new Map<string, string>();
    const plugins = result.entries.map((entry) => {
      if (entry.totalBytes < 1 || entry.totalBytes > PLUGIN_CLIENT_BUNDLE_MAX_BYTES) {
        throw new Error(`Client Plugin bundle size is invalid: ${entry.extensionId}`);
      }
      const key = bundleKey(entry);
      const token = previous.get(key) ?? randomUUID();
      next.set(key, token);
      this.#routes.set(token, { client, entry });
      return Object.freeze({
        ...entry,
        url: `${MAKA_CLIENT_PLUGIN_SCHEME}://bundle/${token}/${entry.clientDigest}.js`,
      });
    });
    for (const [key, token] of previous) {
      if (!next.has(key)) this.#routes.delete(token);
    }
    this.#tokens.set(client, next);
    return Object.freeze({
      authorityEpoch: result.authorityEpoch,
      revision: result.revision,
      plugins: Object.freeze(plugins),
      failures: result.failures,
    });
  }

  release(client: ClientPluginQueryClient): void {
    const remote = client as ClientPluginRemoteClient;
    for (const owner of this.#streamOwners.get(remote)?.values() ?? []) owner.release();
    this.#streamOwners.delete(remote);
    for (const token of this.#tokens.get(client)?.values() ?? []) this.#routes.delete(token);
    this.#tokens.delete(client);
  }

  async serve(requestUrl: string): Promise<Response> {
    const requested = routeRequest(requestUrl);
    const route = requested ? this.#routes.get(requested.token) : undefined;
    if (!route || requested?.clientDigest !== route.entry.clientDigest) {
      return response('Client Plugin bundle is stale or unavailable', 404);
    }
    try {
      const chunks: Buffer[] = [];
      let offset = 0;
      while (offset < route.entry.totalBytes) {
        const result = await route.client.request('plugin.client.query', {
          kind: 'bundle',
          extensionId: route.entry.extensionId,
          contentDigest: route.entry.contentDigest,
          clientDigest: route.entry.clientDigest,
          offset,
        });
        if (
          result.kind !== 'bundle' ||
          result.extensionId !== route.entry.extensionId ||
          result.contentDigest !== route.entry.contentDigest ||
          result.clientDigest !== route.entry.clientDigest ||
          result.offset !== offset ||
          result.totalBytes !== route.entry.totalBytes
        ) {
          throw new Error('Runtime Host returned a mismatched Client Plugin bundle page');
        }
        const chunk = Buffer.from(result.content, 'base64');
        if (chunk.byteLength === 0) throw new Error('Runtime Host returned an empty bundle page');
        chunks.push(chunk);
        offset += chunk.byteLength;
        if (result.nextOffset !== (offset < result.totalBytes ? offset : null)) {
          throw new Error('Runtime Host returned a discontinuous bundle page');
        }
      }
      const content = Buffer.concat(chunks, route.entry.totalBytes);
      const digest = `sha256-${createHash('sha256').update(content).digest('hex')}`;
      if (content.byteLength !== route.entry.totalBytes || digest !== route.entry.clientDigest) {
        throw new Error('Client Plugin bundle integrity check failed');
      }
      return new Response(content, {
        status: 200,
        headers: {
          'content-type': 'text/javascript; charset=utf-8',
          'cache-control': 'no-store',
          'content-security-policy': "default-src 'none'",
        },
      });
    } catch {
      return response('Client Plugin bundle is stale or unavailable', 409);
    }
  }
}

export function registerClientPluginIpc(input: {
  readonly ipcMain: ReconnectableReadIpcMain;
  readonly client: ClientPluginQueryClient & ClientPluginRemoteClient;
  readonly transport: ClientPluginTransport;
}): void {
  handleReconnectableRead(input.ipcMain, 'client-plugins:snapshot', () =>
    input.transport.snapshot(input.client),
  );
  input.ipcMain.handle('client-plugins:remote:call', (_event, request) =>
    input.client.request('plugin.client.remote.call', request),
  );
  input.ipcMain.handle('client-plugins:remote:stream:open', (event, request) =>
    input.transport.openStream(input.client, event.sender, request),
  );
  input.ipcMain.handle('client-plugins:remote:stream:next', async (event, request) => {
    const current = () => input.transport.ownsStream(input.client, event.sender.id, request.streamId);
    if (typeof request?.streamId === 'string' && !current()) return { done: true };
    try {
      const result = await input.client.request('plugin.client.remote.stream.next', request);
      if (result.done) input.transport.forgetStream(input.client, request.streamId);
      return result;
    } catch (error) {
      if (!current()) return { done: true };
      input.transport.forgetStream(input.client, request.streamId);
      throw error;
    }
  });
  input.ipcMain.handle('client-plugins:remote:stream:close', async (event, request) => {
    if (typeof request?.streamId === 'string' && !input.transport.ownsStream(input.client, event.sender.id, request.streamId)) return { streamId: request.streamId };
    const result = await input.client.request('plugin.client.remote.stream.close', request);
    input.transport.forgetStream(input.client, request.streamId);
    return result;
  });
}

function bundleKey(entry: PluginClientCompositionEntry): string {
  return `${entry.extensionId}\u0000${entry.contentDigest}\u0000${entry.clientDigest}`;
}

function routeRequest(
  requestUrl: string,
): { readonly token: string; readonly clientDigest: string } | undefined {
  try {
    const url = new URL(requestUrl);
    const segments = url.pathname.split('/').filter(Boolean);
    if (
      url.protocol !== `${MAKA_CLIENT_PLUGIN_SCHEME}:` ||
      url.hostname !== 'bundle' ||
      segments.length !== 2 ||
      !/^[0-9a-f-]{36}$/u.test(segments[0] ?? '') ||
      !/^sha256-[a-f0-9]{64}\.js$/u.test(segments[1] ?? '')
    ) {
      return undefined;
    }
    return {
      token: segments[0]!,
      clientDigest: segments[1]!.slice(0, -'.js'.length),
    };
  } catch {
    return undefined;
  }
}

function response(body: string, status: number): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
  });
}
