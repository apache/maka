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
    const jobs = jobId ? [this.cache.job(jobId)] : this.cache.jobs();
    return {
      jobs: jobs.map((j) => ({
        jobId: j.id,
        startTime: j.startTime,
        endTime: j.endTime,
        status: j.status,
        phase: j.phase,
        pages: j.pages,
        messages: Number(
          this.cache.db.prepare('SELECT COUNT(*) n FROM staged WHERE job=?').get(j.id)!.n,
        ),
        updatedAt: j.updatedAt,
        completedAt: j.completedAt,
        publication: j.publication,
        error: j.error,
      })),
      publishedBoundary: this.cache.boundary(),
      notice:
        '仅完整同步批次对记忆发布。聊天历史加消息搜索不保证获取飞书全部历史或所有旧话题回复；不会自动同步。',
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
      running = this.run(job, caller).finally(() => this.runs.delete(job.id));
      this.runs.set(job.id, running);
    }
    return running;
  }
  private next(job: any, data: any, key: string) {
    if (data.has_more && (typeof data.page_token !== 'string' || !data.page_token))
      throw Error('Missing provider pagination cursor');
    const next = data.has_more ? data.page_token : undefined;
    if (next) {
      const marker = `${key}:${next}`;
      if (job.seen.includes(marker)) throw Error('Repeated provider pagination cursor');
      job.seen.push(marker);
    }
    return next;
  }
  private inScope(m: any, job: any) {
    identifier(m.message_id);
    if (!Number.isFinite(Number(m.create_time))) throw Error('Missing original message timestamp');
    const scope = this.cache.scope;
    return (
      Number(m.create_time) >= job.startTime * 1000 &&
      Number(m.create_time) < job.endTime * 1000 &&
      (!scope.containers.length ||
        scope.containers.some((c: any) =>
          c.type === 'chat' ? c.id === m.chat_id : c.id === m.thread_id,
        ))
    );
  }
  private async run(job: any, caller: any) {
    try {
      while (job.phase !== 'complete') {
        caller.invocation.abortSignal?.throwIfAborted();
        if (job.phase === 'chats') {
          if (this.cache.scope.containers.length) {
            job.chats = this.cache.scope.containers
              .filter((c: any) => c.type === 'chat')
              .map((c: any) => c.id);
            // Explicit thread scope is resolved by bounded search, not full historical traversal.
            job.phase = 'history';
            this.cache.page(job, []);
            continue;
          }
          const data = await this.api(
            'GET',
            '/im/v1/chats',
            { page_size: '100', ...(job.cursor ? { page_token: job.cursor } : {}) },
            undefined,
            caller,
          );
          if (!Array.isArray(data.items)) throw Error('Invalid chat directory');
          job.chats = [
            ...new Set([...job.chats, ...data.items.map((c: any) => identifier(c.chat_id))]),
          ];
          job.cursor = this.next(job, data, 'chats');
          if (!job.cursor) job.phase = 'history';
          this.cache.page(job, []);
          continue;
        }
        if (job.phase === 'history') {
          if (job.chatIndex >= job.chats.length) {
            job.phase = 'search';
            job.cursor = undefined;
            this.cache.page(job, []);
            continue;
          }
          const chat = job.chats[job.chatIndex];
          const data = await this.api(
            'GET',
            '/im/v1/messages',
            {
              container_id_type: 'chat',
              container_id: chat,
              start_time: String(job.startTime),
              end_time: String(job.endTime),
              sort_type: 'ByCreateTimeAsc',
              page_size: '50',
              ...(job.cursor ? { page_token: job.cursor } : {}),
            },
            undefined,
            caller,
          );
          if (!Array.isArray(data.items)) throw Error('Invalid message page');
          const messages = data.items.filter((m: any) => this.inScope(m, job));
          job.cursor = this.next(job, data, `chat:${chat}`);
          if (!job.cursor) job.chatIndex++;
          this.cache.page(job, messages);
          continue;
        }
        if (job.phase !== 'search') throw Error('Unknown sync phase');
        const data = await this.api(
          'POST',
          '/im/v1/messages/search',
          { page_size: '50', ...(job.cursor ? { page_token: job.cursor } : {}) },
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
        job.cursor = this.next(job, data, 'search');
        if (!job.cursor) job.phase = 'complete';
        this.cache.page(job, messages);
      }
      // A new invocation forces account verification again at the publication boundary.
      await this.verify({ ...caller, invocation: { ...caller.invocation } });
      this.cache.publish(job);
    } catch (e) {
      // Save ONLY the last committed page state. In-memory mutations from a failed page are discarded.
      const durable = this.cache.job(job.id);
      durable.status = 'failed';
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
