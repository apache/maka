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
import { createCli, type CliConfig, type CliRun } from './cli.js';
type Kind = 'documents' | 'tasks' | 'calendar';
export type SourcesConfig = CliConfig & {
  instanceId: string;
  kinds?: Kind[];
  containers?: any[];
  startTime?: number;
  endTime?: number;
  messageSource?: any;
  signingKey?: string;
  messageStartTime?: number;
  messageEndTime?: number;
  calendarId?: string;
  documentQuery?: string;
};
const hash = (x: any) => createHash('sha256').update(JSON.stringify(x)).digest('hex');
async function mapReads<T, R>(items: readonly T[], fn: (item: T) => Promise<R>): Promise<R[]> {
  const result: R[] = [];
  for (let i = 0; i < items.length; i += 4)
    result.push(...(await Promise.all(items.slice(i, i + 4).map(fn))));
  return result;
}
const id = (value: any) => {
  if (typeof value !== 'string' || !/^[\w@.\-]+$/.test(value))
    throw Error('Invalid native source ID');
  return value;
};
export function createCliSources(config: SourcesConfig, run?: CliRun) {
  if (!/^[a-z0-9][a-z0-9._-]{0,40}$/.test(config.instanceId)) throw Error('Invalid instanceId');
  const cli = createCli(config, run);
  const result: any[] = [];
  for (const kind of config.kinds ?? ['documents', 'tasks', 'calendar']) {
    if (!['documents', 'tasks', 'calendar'].includes(kind))
      throw Error('Unsupported CLI source kind');
    if (
      kind === 'calendar' &&
      (!Number.isSafeInteger(config.startTime) ||
        !Number.isSafeInteger(config.endTime) ||
        config.endTime! <= config.startTime!)
    )
      throw Error('Calendar requires explicit startTime/endTime Unix seconds');
    const scope = {
      accountId: config.accountId,
      appId: config.appId,
      kind,
      ...(kind === 'calendar'
        ? {
            calendarId: config.calendarId ?? 'primary',
            startTime: config.startTime,
            endTime: config.endTime,
          }
        : {}),
      ...(kind === 'documents'
        ? { query: config.documentQuery ?? '', types: ['docx', 'wiki'] }
        : {}),
    };
    const key = config.signingKey ?? randomBytes(32);
    const encode = (state: any) => {
      const s = Buffer.from(JSON.stringify(state)).toString('base64url');
      return s + '.' + createHmac('sha256', key).update(s).digest('hex');
    };
    const decode = (s: string) => {
      const [v, mac] = s.split('.');
      if (mac !== createHmac('sha256', key).update(v).digest('hex'))
        throw Error('Invalid source cursor');
      return JSON.parse(Buffer.from(v, 'base64url').toString());
    };
    const cache = new WeakMap<object, Map<string, any>>();
    const memo = (caller: any) => {
      let m = cache.get(caller.invocation);
      if (!m) {
        m = new Map();
        cache.set(caller.invocation, m);
      }
      return m;
    };
    async function native(locator: any, caller: any) {
      const identifier = id(locator.nativeId);
      if (kind === 'documents')
        return (
          await cli.call(['api', 'GET', `/open-apis/docx/v1/documents/${identifier}`], caller)
        ).document;
      if (kind === 'tasks')
        return (await cli.call(['task', 'tasks', 'get', '--task-guid', identifier], caller)).task;
      return await cli
        .call(
          [
            'calendar',
            '+get',
            '--calendar-id',
            config.calendarId ?? 'primary',
            '--event-id',
            identifier,
          ],
          caller,
        )
        .then((x) => x.event ?? x);
    }
    function object(n: any, locator: any, url?: string) {
      const identifier = String(n.document_id ?? n.guid ?? n.event_id);
      if (!identifier || identifier === 'undefined') throw Error('Missing native object ID');
      const revision = kind === 'documents' ? String(n.revision_id) : hash(n);
      if (!revision || revision === 'undefined') throw Error('Missing document revision');
      return {
        id: identifier,
        locator: { ...locator, nativeId: identifier },
        revision,
        kind: kind === 'documents' ? 'document' : kind === 'tasks' ? 'task' : 'calendar',
        title: String(n.title ?? n.summary ?? identifier).slice(0, 200),
        ...(url || n.url || n.app_link ? { url: url ?? n.url ?? n.app_link } : {}),
        ...(Number(n.updated_at ?? locator.discoveredUpdatedAt) > 0
          ? { updatedAt: Number(n.updated_at ?? locator.discoveredUpdatedAt) }
          : {}),
      };
    }
    async function load(o: any, caller: any) {
      if (o.id !== o.locator.nativeId) throw Error('Object locator does not match identity');
      const c = memo(caller);
      if (!c.has(o.id)) c.set(o.id, await native(o.locator, caller));
      return c.get(o.id);
    }
    async function query(q: any, caller: any) {
      if (Object.keys(q).some((k) => !['cursor', 'text', 'limit'].includes(k)))
        throw Error('Unsupported source query field');
      if (q.text !== undefined && typeof q.text !== 'string') throw Error('Invalid text');
      const limit = q.limit ?? 20;
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw Error('limit must be 1..100');
      const shape = hash({ text: q.text ?? '', limit, scope });
      const state = q.cursor ? decode(q.cursor) : {};
      if (q.cursor && state.shape !== shape) throw Error('Cursor query changed');
      let data: any, rows: any[];
      if (kind === 'documents') {
        data = await cli.call(
          [
            'drive',
            '+search',
            '--doc-types',
            'docx,wiki',
            '--query',
            config.documentQuery || q.text || '',
            '--page-size',
            String(Math.min(limit, 20)),
            ...(state.page ? ['--page-token', state.page] : []),
          ],
          caller,
        );
        rows = data.results ?? [];
      } else if (kind === 'tasks') {
        data = await cli.call(
          [
            'task',
            'tasks',
            'list',
            '--page-size',
            String(limit),
            ...(state.page ? ['--page-token', state.page] : []),
          ],
          caller,
        );
        rows = data.items ?? [];
      } else {
        data = await cli.call(
          [
            'calendar',
            '+agenda',
            '--calendar-id',
            config.calendarId ?? 'primary',
            '--start',
            new Date(config.startTime! * 1000).toISOString(),
            '--end',
            new Date(config.endTime! * 1000).toISOString(),
          ],
          caller,
        );
        if (!Array.isArray(data)) throw Error('Unexpected calendar agenda shape');
        rows = data;
      }
      const items = (
        await mapReads(rows, async (row) => {
          let identifier: string, url: string | undefined;
          let discovery: Record<string, unknown> = {};
          if (kind === 'documents') {
            const meta = row.result_meta;
            url = meta.url;
            discovery = {
              discoveredAt: Date.now(),
              discoveredCreatedAt: Number(meta.create_time) * 1000 || null,
              discoveredUpdatedAt: Number(meta.update_time) * 1000 || null,
            };
            const found = await cli.call(['drive', '+inspect', '--url', url!], caller);
            if (found.type !== 'docx') return undefined; // This source explicitly covers docx, including wiki-wrapped docx.
            identifier = id(found.token);
          } else identifier = id(row.guid ?? row.event_id);
          const n = await native({ nativeId: identifier }, caller);
          const o = object(n, { nativeId: identifier, ...discovery }, url);
          memo(caller).set(o.id, n);
          if (
            !q.text ||
            (kind === 'documents' && !config.documentQuery) ||
            JSON.stringify(n).toLowerCase().includes(q.text.toLowerCase())
          )
            return o;
          return undefined;
        })
      ).filter(Boolean);
      if (data.has_more && (!data.page_token || data.page_token === state.page))
        throw Error('Invalid provider pagination');
      return {
        items,
        ...(data.has_more ? { next: encode({ shape, page: data.page_token }) } : {}),
      };
    }
    result.push({
      id: `feishu.${config.instanceId}.${kind}`,
      description: `Feishu ${kind} via local CLI (read-only)`,
      scope,
      queryHelp:
        '{text?:string, limit?:number (1..100), cursor?:string}. Keep text and limit unchanged while following next. Documents: docx and wiki-wrapped docx. Calendar: configured time window. Tasks: my tasks. Empty pages may have next. Original is fetched on demand.',
      enumerate: (cursor: any, caller: any) => query({ cursor }, caller),
      query,
      async authorize(objects: readonly any[], caller: any) {
        await cli.verify(caller);
        return mapReads(objects, async (o) => {
          await load(o, caller);
          return o.id;
        });
      },
      async read(o: any, caller: any) {
        const n = await load(o, caller);
        if (n.status === 'cancelled')
          return { status: 'deleted', object: object(n, o.locator, o.url) };
        if (kind === 'documents') {
          if (String(n.revision_id) !== o.revision)
            return { status: 'version_unavailable', object: object(n, o.locator, o.url) };
          const d = await cli.call(
            [
              'docs',
              '+fetch',
              '--doc',
              id(o.id),
              '--doc-format',
              'markdown',
              '--revision-id',
              String(n.revision_id),
            ],
            caller,
          );
          const doc = d.document;
          if (!doc || String(doc.revision_id) !== String(n.revision_id))
            throw Error('Document changed during read; retry');
          return {
            status: 'ok',
            object: object(n, o.locator, o.url),
            content: doc,
          };
        }
        return {
          status: 'ok',
          object: object(n, o.locator, o.url),
          content: n,
        };
      },
    });
  }
  if (config.messageSource) result.push(config.messageSource);
  return result;
}
