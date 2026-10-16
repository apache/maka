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

import { MessageCache } from './message-cache.js';
export type MessageApi = (
  method: 'GET' | 'POST',
  path: string,
  params: any,
  body: any,
  caller: any,
) => Promise<any>;
const iso = (s: number) => new Date(s * 1000).toISOString().replace('.000Z', 'Z');
const identifier = (s: unknown) => {
  if (typeof s !== 'string' || !/^[A-Za-z0-9_-]+$/.test(s)) throw Error('Invalid native ID');
  return s;
};

/** No model calls and no recursive traversal of old threads. */
export class MessageSync {
  private runs = new Map<string, Promise<any>>();
  private stopping = new AbortController();
  constructor(
    readonly cache: MessageCache,
    readonly api: MessageApi,
    readonly verify: (caller: any) => Promise<void>,
  ) {}
  status(jobId?: string) {
    const job = jobId ? this.cache.job(jobId) : this.cache.latest();
    const source = `feishu.${this.cache.scope.instanceId}.messages`;
    if (!job) return { configured: true, synchronized: false, source };
    const count = (sql: string) => Number(this.cache.db.prepare(sql).get(job.id)!.n);
    return {
      configured: true,
      synchronized: job.status === 'complete',
      source,
      jobId: job.id,
      status: job.status,
      range: { startTime: job.startTime, endTime: job.endTime, containers: job.containers },
      phase: job.phase,
      pages: job.pages,
      discoveredChats: count('SELECT COUNT(*) n FROM sync_chats WHERE job=?'),
      completedChats: count(
        "SELECT COUNT(*) n FROM sync_chats WHERE job=? AND json_extract(payload,'$.done')=1",
      ),
      downloadedMessages: count('SELECT COUNT(*) n FROM sync_members WHERE job=?'),
      startedAt: job.startedAt,
      updatedAt: job.updatedAt,
      finishedAt: job.finishedAt,
      error: job.error,
      notice:
        '仅完整同步任务对记忆发布；范围为 [startTime,endTime)，单位秒。聊天历史加消息搜索不保证获取飞书全部历史或所有旧话题回复；定期同步需通过 FeishuSyncControl 单独开启。',
    };
  }
  async sync(input: { startTime: number; endTime: number; refresh?: boolean }, caller: any) {
    caller = {
      ...caller,
      invocation: {
        ...caller.invocation,
        abortSignal: caller.invocation.abortSignal
          ? AbortSignal.any([caller.invocation.abortSignal, this.stopping.signal])
          : this.stopping.signal,
      },
    };
    caller.invocation.abortSignal.throwIfAborted();
    await this.verify(caller);
    const { startTime, endTime } = input;
    if (
      ![startTime, endTime].every((x) => Number.isSafeInteger(x) && x >= 0) ||
      startTime >= endTime
    )
      throw Error('Time bounds must be integer Unix seconds with startTime < endTime');
    const scope = this.cache.scope;
    if (startTime < (scope.startTime ?? 0) || endTime > (scope.endTime ?? Infinity))
      throw Error('Sync range outside configured source scope');
    const job = this.cache.begin(startTime, endTime, input.refresh);
    if (job.status === 'complete') return { ...this.status(job.id), reused: true };
    let running = this.runs.get(job.id);
    if (!running) {
      if (this.runs.size)
        throw Error('Another message sync is running; retry this range after it finishes');
      running = this.run(job, caller).finally(() => this.runs.delete(job.id));
      this.runs.set(job.id, running);
    }
    return running;
  }
  private next(data: any) {
    if (data.has_more && (typeof data.page_token !== 'string' || !data.page_token))
      throw Error('Missing provider pagination cursor');
    return data.has_more ? (data.page_token as string) : null;
  }
  private inScope(m: any, job: any) {
    identifier(m.message_id);
    if (!Number.isFinite(Number(m.create_time))) throw Error('Missing original message timestamp');
    return this.cache.inScope(m, job) && this.cache.inScope(m);
  }
  private async run(job: any, caller: any) {
    try {
      while (job.phase !== 'complete') {
        caller.invocation.abortSignal?.throwIfAborted();
        caller.assertActive?.();
        if (job.phase === 'discover') {
          if (job.containers.length) {
            job.phase = 'history';
            this.cache.page(job, [], {
              chats: job.containers.filter((c: any) => c.type === 'chat').map((c: any) => c.id),
              count: false,
            });
            continue;
          }
          const data = await this.api(
            'GET',
            '/im/v1/chats',
            {
              types: 'p2p,group',
              page_size: '100',
              ...(job.chatsPage ? { page_token: job.chatsPage } : {}),
            },
            undefined,
            caller,
          );
          caller.assertActive?.();
          if (!Array.isArray(data.items)) throw Error('Invalid chat directory');
          job.chatsPage = this.next(data);
          if (!job.chatsPage) job.phase = 'history';
          this.cache.page(job, [], {
            chats: data.items.map((c: any) => identifier(c.chat_id)),
            kind: 'discover',
            next: job.chatsPage,
          });
          continue;
        }
        if (job.phase === 'history') {
          const chat = this.cache.nextChat(job.id);
          if (!chat) {
            job.phase = 'search';
            this.cache.save(job);
            continue;
          }
          const data = await this.api(
            'GET',
            '/im/v1/messages',
            {
              container_id_type: 'chat',
              container_id: chat.id,
              start_time: String(job.startTime),
              end_time: String(job.endTime),
              sort_type: 'ByCreateTimeAsc',
              page_size: '50',
              ...(chat.page ? { page_token: chat.page } : {}),
            },
            undefined,
            caller,
          );
          caller.assertActive?.();
          if (!Array.isArray(data.items)) throw Error('Invalid message page');
          const page = this.next(data);
          this.cache.page(
            job,
            data.items.filter((m: any) => this.inScope(m, job)),
            {
              chat: { id: chat.id, page, done: !page },
              kind: `chat:${chat.id}`,
              next: page,
            },
          );
          continue;
        }
        if (job.phase === 'publish') {
          await this.verify({ ...caller, invocation: { ...caller.invocation } });
          caller.assertActive?.();
          this.cache.publish(job);
          continue;
        }
        if (job.phase !== 'search') throw Error('Unknown sync phase');
        const data = await this.api(
          'POST',
          '/im/v1/messages/search',
          { page_size: '50', ...(job.searchPage ? { page_token: job.searchPage } : {}) },
          {
            query: '',
            filter: { time_range: { start_time: iso(job.startTime), end_time: iso(job.endTime) } },
          },
          caller,
        );
        if (!Array.isArray(data.items)) throw Error('Invalid search page');
        const ids = [
          ...new Set<string>(
            data.items.map((m: any) => identifier(m.meta_data?.message_id ?? m.message_id)),
          ),
        ].filter((id) => !this.cache.has(job.id, id));
        const messages: any[] = [];
        for (let at = 0; at < ids.length; at += 50) {
          const batch = ids.slice(at, at + 50);
          const found = await this.api(
            'GET',
            '/im/v1/messages/mget',
            { message_ids: batch },
            undefined,
            caller,
          );
          if (!Array.isArray(found.items)) throw Error('Invalid mget response');
          const returned = new Set(found.items.map((m: any) => m.message_id));
          if (batch.some((id) => !returned.has(id)))
            throw Error('mget omitted an original; cannot assume deletion');
          messages.push(...found.items.filter((m: any) => this.inScope(m, job)));
        }
        caller.assertActive?.();
        job.searchPage = this.next(data);
        if (!job.searchPage) job.phase = 'publish';
        this.cache.page(job, messages, { kind: 'search', next: job.searchPage });
      }
    } catch (e) {
      caller.assertActive?.();
      // Save ONLY the last committed page state. In-memory mutations from a failed page are discarded.
      const durable = this.cache.job(job.id);
      durable.status = 'incomplete';
      durable.error = String(e);
      this.cache.save(durable);
    }
    return this.status(job.id);
  }
  async close() {
    this.stopping.abort(Error('Message sync stopped; repeat the same range to resume'));
    await Promise.allSettled(this.runs.values());
  }
}
