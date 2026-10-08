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

import { createHash, createHmac, randomBytes } from 'node:crypto';
export type Container = { type: 'chat' | 'thread'; id: string };
export type FeishuConfig = {
  instanceId: string;
  domain?: 'feishu' | 'lark';
  containers: Container[];
  startTime: number;
  endTime?: number;
};
export type MessageDiscovery = {
  chats: (
    cursor: string | undefined,
    caller: any,
  ) => Promise<{ items: Container[]; next?: string }>;
  search: (query: any, caller: any) => Promise<{ items: any[]; next?: string }>;
};
export function createFeishuSource(
  config: FeishuConfig,
  token: () => Promise<string>,
  request: typeof fetch = fetch,
  transport?: (path: string, query: Record<string, string>, caller: any) => Promise<any>,
  discovery?: MessageDiscovery,
) {
  if (!/^[a-z0-9][a-z0-9._-]{0,55}$/.test(config.instanceId))
    throw Error('A stable account/tenant instanceId is required');
  if (
    (!config.containers?.length && !discovery) ||
    config.containers.some(
      (c) => !['chat', 'thread'].includes(c.type) || !/^[a-zA-Z0-9_-]+$/.test(c.id),
    )
  )
    throw Error('Explicit chat/thread containers are required');
  if (
    !Number.isSafeInteger(config.startTime) ||
    config.startTime < 0 ||
    (config.endTime !== undefined &&
      (!Number.isSafeInteger(config.endTime) || config.endTime <= config.startTime))
  )
    throw Error('Invalid source time scope');
  if (config.domain && !['feishu', 'lark'].includes(config.domain))
    throw Error('Invalid API domain');
  const base =
    config.domain === 'lark'
      ? 'https://open.larksuite.com/open-apis'
      : 'https://open.feishu.cn/open-apis';
  const digest = (value: unknown) =>
    createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const scope = {
    containers: config.containers.length ? config.containers : 'all-accessible',
    startTime: config.startTime,
    endTime: config.endTime ?? 'scan-start',
  };
  const scopeHash = digest(scope),
    cursorKey = randomBytes(32);
  const sign = (s: string) => createHmac('sha256', cursorKey).update(s).digest('base64url');
  const encode = (v: any) => {
    const s = Buffer.from(JSON.stringify(v)).toString('base64url');
    return s + '.' + sign(s);
  };
  const decode = (cursor: string) => {
    const [s, mac] = cursor.split('.');
    if (!mac || mac !== sign(s)) throw Error('Invalid or expired source cursor');
    return JSON.parse(Buffer.from(s, 'base64url').toString());
  };
  const calls = new WeakMap<object, Map<string, any>>();
  function cache(caller: any) {
    const identity = caller.invocation;
    if (!identity) throw Error('Source requires invocation');
    let c = calls.get(identity);
    if (!c) {
      c = new Map();
      calls.set(identity, c);
    }
    return c;
  }
  async function api(path: string, query: Record<string, string>, caller: any) {
    if (transport) return transport(path, query, caller);
    const url = new URL(base + path);
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    const secret = (await token()).trim();
    if (!secret) throw Error('Feishu access token is not configured');
    const signal = caller.invocation?.abortSignal;
    signal?.throwIfAborted();
    const response = await request(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${secret}` },
      signal,
      redirect: 'error',
    });
    if (!response.ok) throw Error(`Feishu HTTP ${response.status}`);
    const data: any = await response.json();
    if (data.code !== 0)
      throw Error(
        `Feishu API error ${data.code}; verify token, permissions and chat membership`,
      );
    return data.data;
  }
  function normalize(m: any) {
    return {
      message_id: m.message_id,
      chat_id: m.chat_id,
      root_id: m.root_id ?? '',
      parent_id: m.parent_id ?? '',
      thread_id: m.thread_id ?? '',
      msg_type: m.msg_type,
      create_time: m.create_time,
      update_time: m.update_time ?? m.create_time,
      deleted: !!m.deleted,
      sender: m.sender ?? null,
      body: m.body ?? null,
      mentions: m.mentions ?? [],
    };
  }
  function object(m: any) {
    return {
      id: m.message_id,
      locator: {
        chatId: m.chat_id,
        messageId: m.message_id,
        threadId: m.thread_id ?? '',
        createdAt: Number(m.create_time),
      },
      revision: digest(normalize(m)),
      kind: m.msg_type,
      title: `${m.msg_type} · ${new Date(Number(m.create_time)).toISOString()}`,
      updatedAt: Number(m.update_time ?? m.create_time),
    };
  }
  function inScope(m: any, endTime = config.endTime ?? Infinity) {
    return (
      (config.containers.length === 0 ||
        config.containers.some((c) =>
          c.type === 'chat' ? c.id === m.chat_id : c.id === m.thread_id,
        )) &&
      Number(m.create_time) >= config.startTime * 1000 &&
      Number(m.create_time) < endTime * 1000
    );
  }
  async function message(id: string, caller: any) {
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw Error('Invalid message ID');
    const c = cache(caller);
    if (c.has(id)) return c.get(id);
    const data = await api(`/im/v1/messages/${encodeURIComponent(id)}`, {}, caller);
    const m = data.items?.find((x: any) => x.message_id === id);
    if (!m) throw Error('Feishu message unavailable');
    c.set(id, m);
    return m;
  }
  async function scan(cursor: string | undefined, caller: any, query: any = {}) {
    const state = cursor
      ? decode(cursor)
      : {
          scopeHash,
          queryHash: digest(query),
          endTime: Math.min(
            config.endTime ?? Infinity,
            query.endTime ?? Infinity,
            Math.floor(Date.now() / 1000),
          ),
          queue: query.chatId ? [{ type: 'chat', id: query.chatId }] : [...config.containers],
          discover: !query.chatId && config.containers.length === 0,
          chatsPage: undefined,
          seenChats: [],
          visited: config.containers.filter((c) => c.type === 'thread').map((c) => c.id),
          page: undefined,
        };
    if (state.scopeHash !== scopeHash || state.queryHash !== digest(query))
      throw Error('Source cursor scope or query changed');
    if (!state.queue.length && state.discover) {
      const page = await discovery!.chats(state.chatsPage, caller);
      if (page.next && page.next === state.chatsPage) throw Error('Invalid chat pagination');
      for (const chat of page.items) {
        if (!state.seenChats.includes(chat.id)) {
          state.seenChats.push(chat.id);
          state.queue.push(chat);
        }
      }
      state.chatsPage = page.next;
      state.discover = !!page.next;
    }
    const current = state.queue[0];
    if (!current) return { items: [], ...(state.discover ? { next: encode(state) } : {}) };
    const data = await api(
      '/im/v1/messages',
      {
        container_id_type: current.type,
        container_id: current.id,
        page_size: String(query.limit ?? 50),
        sort_type: 'ByCreateTimeAsc',
        ...(current.type === 'chat'
          ? { start_time: '0', end_time: String(state.endTime) }
          : {}),
        ...(state.page ? { page_token: state.page } : {}),
      },
      caller,
    );
    cache(caller).set(`@access:${current.type}:${current.id}`, true);
    const items: any[] = [];
    for (const m of data.items ?? []) {
      // Old roots can have new replies. Discover threads before filtering by message time.
      if (m.thread_id && !state.visited.includes(m.thread_id)) {
        state.visited.push(m.thread_id);
        state.queue.push({ type: 'thread', id: m.thread_id });
      }
      if (
        !inScope(m, state.endTime) ||
        Number(m.create_time) < (query.startTime ?? config.startTime) * 1000 ||
        (query.chatId && m.chat_id !== query.chatId)
      )
        continue;
      cache(caller).set(m.message_id, m);
      items.push(object(m));
    }
    if (data.has_more) {
      if (!data.page_token || data.page_token === state.page)
        throw Error('Feishu returned an invalid page cursor');
      state.page = data.page_token;
    } else {
      state.queue.shift();
      delete state.page;
    }
    return { items, ...(state.queue.length || state.discover ? { next: encode(state) } : {}) };
  }
  return {
    id: `feishu.${config.instanceId}`,
    description: config.containers.length
      ? 'Feishu messages in configured chats/threads'
      : 'Feishu messages across all provider-discoverable private and group chats',
    scope,
    queryHelp:
      '{cursor?:string, text?:string, types?:string[], chatId?:string, startTime?:number, endTime?:number, limit?:number (1..50)}. Default scans all accessible private/group chats; text/chatId/time filters use native search in default all-chat CLI mode. chatId/time/types narrow results. Follow next even when empty, preserving all query fields. Native search is not exhaustive coverage; enumerate with {} to scan the source. New chats are discovered on each fresh scan. Thread replies included. Bounds: integer Unix seconds (floor start, ceil end); record timestamps: milliseconds.',
    enumerate: scan,
    async query(query: any, caller: any) {
      const allowed = ['cursor', 'text', 'types', 'chatId', 'startTime', 'endTime', 'limit'];
      if (Object.keys(query).some((k) => !allowed.includes(k)))
        throw Error('Unsupported Feishu query field');
      if (query.text !== undefined && typeof query.text !== 'string')
        throw Error('Invalid text query');
      if (
        query.types !== undefined &&
        (!Array.isArray(query.types) || query.types.some((x: any) => typeof x !== 'string'))
      )
        throw Error('Invalid types query');
      if (
        query.chatId !== undefined &&
        (typeof query.chatId !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(query.chatId))
      )
        throw Error('Invalid chatId');
      if (
        query.chatId &&
        config.containers.length &&
        !config.containers.some((c) => c.type === 'chat' && c.id === query.chatId)
      )
        throw Error('Chat outside configured scope');
      for (const field of ['startTime', 'endTime'])
        if (
          query[field] !== undefined &&
          (!Number.isSafeInteger(query[field]) || query[field] < 0)
        )
          throw Error('Invalid time query');
      if (
        query.limit !== undefined &&
        (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > 50)
      )
        throw Error('Invalid limit');
      if (
        Math.max(config.startTime, query.startTime ?? 0) >=
        Math.min(config.endTime ?? Infinity, query.endTime ?? Infinity)
      )
        throw Error('Invalid time range');
      const { cursor, ...shape } = query;
      const providerSearch =
        discovery &&
        !config.containers.length &&
        (query.text ||
          query.chatId ||
          query.startTime !== undefined ||
          query.endTime !== undefined);
      let page: { items: any[]; next?: string };
      if (providerSearch) {
        const state = cursor
          ? decode(cursor)
          : {
              scopeHash,
              queryHash: digest(shape),
              endTime: Math.min(
                config.endTime ?? Infinity,
                query.endTime ?? Infinity,
                Math.floor(Date.now() / 1000),
              ),
            };
        if (state.scopeHash !== scopeHash || state.queryHash !== digest(shape))
          throw Error('Source cursor scope or query changed');
        const found = await discovery!.search(
          {
            ...shape,
            startTime: Math.max(config.startTime, query.startTime ?? 0),
            endTime: state.endTime,
            cursor: state.page,
          },
          caller,
        );
        if (found.next && found.next === state.page) throw Error('Invalid search pagination');
        const items = found.items.filter(
          (m) =>
            inScope(m, state.endTime) &&
            Number(m.create_time) >= Math.max(config.startTime, query.startTime ?? 0) * 1000 &&
            (!query.chatId || m.chat_id === query.chatId),
        );
        for (const m of items) cache(caller).set(m.message_id, m);
        page = {
          items: items.map(object),
          ...(found.next ? { next: encode({ ...state, page: found.next }) } : {}),
        };
      } else page = await scan(cursor, caller, shape);
      return {
        ...page,
        items: page.items.filter(
          (o) =>
            (!query.types || query.types.includes(o.kind)) &&
            (!query.text ||
              providerSearch ||
              JSON.stringify(normalize(cache(caller).get(o.id)))
                .toLowerCase()
                .includes(query.text.toLowerCase())),
        ),
      };
    },
    async authorize(objects: readonly any[], caller: any) {
      const allowed: string[] = [],
        c = cache(caller);
      for (const o of objects) {
        const container =
          config.containers.length === 0
            ? { type: 'chat', id: o.locator.chatId }
            : config.containers.find((x) =>
                x.type === 'chat' ? x.id === o.locator.chatId : x.id === o.locator.threadId,
              );
        if (
          !container ||
          !/^[a-zA-Z0-9_-]+$/.test(container.id) ||
          o.locator.createdAt < config.startTime * 1000 ||
          (config.endTime && o.locator.createdAt >= config.endTime * 1000)
        )
          continue;
        const accessKey = `@access:${container.type}:${container.id}`;
        if (!c.has(accessKey)) {
          await api(
            '/im/v1/messages',
            {
              container_id_type: container.type,
              container_id: container.id,
              page_size: '1',
            },
            caller,
          );
          c.set(accessKey, true);
        }
        allowed.push(o.id);
      }
      return allowed;
    },
    async read(o: any, caller: any) {
      const m = await message(o.id, caller);
      if (!inScope(m)) throw Error('Message is outside configured source scope');
      if (m.deleted) return { status: 'deleted' as const, object: object(m) };
      if (
        JSON.stringify(m.body ?? '').includes(
          'The message has exceeded the retention period and has been deleted.',
        )
      )
        return { status: 'unavailable' as const, object: object(m) };
      return { status: 'ok' as const, object: object(m), content: m };
    },
  };
}
