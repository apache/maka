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

import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { createCliSources } from './cli-sources.js';
import { createCli } from './cli.js';
import { MessageCache } from './message-cache.js';
import { MessageSync, type MessageApi } from './message-sync.js';
export default {
  packageId: 'dev.maka.feishu-source',
  host: {
    name: 'feishu-source',
    inject: ['sources', 'credentials', 'storage', 'tools'],
    async apply(ctx: any, config: any = {}) {
      if (ctx.maka?.rootId !== 'profile') throw Error('Install feishu-source in profile scope');
      if (
        !/^[a-z0-9][a-z0-9._-]{0,40}$/.test(config.instanceId) ||
        !config.accountId ||
        !config.appId
      )
        throw Error('Feishu requires stable instanceId, accountId and appId');
      if (config.domain && !['feishu', 'lark'].includes(config.domain))
        throw Error('Invalid domain');
      const containers = JSON.parse(config.containers ?? '[]');
      if (
        !Array.isArray(containers) ||
        containers.some(
          (c) => !['chat', 'thread'].includes(c.type) || !/^[A-Za-z0-9_-]+$/.test(c.id),
        )
      )
        throw Error('Invalid containers');
      let location = await ctx.storage.get('data-directory');
      if (!location.value) {
        const path =
          config.dataDirectory ??
          join(homedir(), '.maka', 'plugin-data', 'dev.maka.feishu-source', randomUUID());
        if (!isAbsolute(path)) throw Error('dataDirectory must be absolute');
        try {
          await ctx.storage.set('data-directory', path, { expectedRevision: location.revision });
        } catch {
          location = await ctx.storage.get('data-directory');
          if (!location.value) throw Error('Unable to initialize message storage');
        }
        location = await ctx.storage.get('data-directory');
      }
      const startTime = config.messageStartTime ?? (config.cliPath ? 0 : (config.startTime ?? 0));
      const endTime = config.messageEndTime ?? (config.cliPath ? undefined : config.endTime);
      if (
        !Number.isSafeInteger(startTime) ||
        startTime < 0 ||
        (endTime !== undefined && (!Number.isSafeInteger(endTime) || endTime <= startTime))
      )
        throw Error('Invalid message source time scope');
      const cache = new MessageCache(location.value, {
        instanceId: config.instanceId,
        accountId: config.accountId,
        appId: config.appId,
        domain: config.domain ?? 'feishu',
        containers,
        startTime,
        ...(endTime === undefined ? {} : { endTime }),
      });
      let sync: MessageSync | undefined;
      ctx.effect(
        () => async () => {
          await sync?.close();
          cache.close();
        },
        'feishu-cache',
      );
      let api: MessageApi, verify: (caller: any) => Promise<void>;
      if (config.cliPath) {
        const cli = createCli(config);
        verify = (caller) => cli.verify(caller);
        api = (method, path, params, body, caller) =>
          cli.call(
            [
              'api',
              method,
              '/open-apis' + path,
              '--params',
              JSON.stringify(params),
              ...(body ? ['--data', JSON.stringify(body)] : []),
            ],
            caller,
          );
      } else {
        ctx.credentials.declare({ name: 'access-token', label: 'Feishu read access token' });
        const token = async () => {
          if (config.tokenFile) {
            if (!isAbsolute(config.tokenFile)) throw Error('tokenFile must be absolute');
            if (((await stat(config.tokenFile)).mode & 0o077) !== 0)
              throw Error('tokenFile must be owner-readable only');
            return (await readFile(config.tokenFile, 'utf8')).trim();
          }
          return ctx.credentials.use('access-token', (value: string) => value);
        };
        api = async (method, path, params, body, caller) => {
          const url = new URL(
            (config.domain === 'lark' ? 'https://open.larksuite.com' : 'https://open.feishu.cn') +
              '/open-apis' +
              path,
          );
          for (const [k, v] of Object.entries(params))
            for (const part of Array.isArray(v) ? v : [v]) url.searchParams.append(k, String(part));
          const response = await fetch(url, {
            method,
            headers: {
              Authorization: `Bearer ${await token()}`,
              'Content-Type': 'application/json',
            },
            ...(body ? { body: JSON.stringify(body) } : {}),
            signal: caller.invocation.abortSignal,
            redirect: 'error',
          });
          if (!response.ok) throw Error(`Feishu HTTP ${response.status}`);
          const result: any = await response.json();
          if (result.code !== 0) throw Error(`Feishu API error ${result.code}`);
          return result.data;
        };
        const verified = new WeakMap<object, Promise<void>>();
        verify = async (caller) => {
          caller.invocation.abortSignal?.throwIfAborted();
          if (!verified.has(caller.invocation))
            verified.set(
              caller.invocation,
              api('GET', '/authen/v1/user_info', {}, undefined, caller).then((user) => {
                if (user.open_id !== config.accountId) throw Error('Feishu account changed');
              }),
            );
          await verified.get(caller.invocation);
        };
      }
      const source = cache.source(
        `feishu.${config.instanceId}${config.cliPath ? '.messages' : ''}`,
        verify,
      );
      if (config.cliPath)
        for (const s of createCliSources({
          ...config,
          kinds: JSON.parse(config.kinds ?? '["documents","tasks","calendar"]'),
          containers,
          messageSource: source,
          signingKey: cache.key,
        }))
          ctx.sources.register(s);
      else ctx.sources.register(source);
      sync = new MessageSync(cache, api, verify);
      for (const [name, description, parameters, impl] of [
        [
          'FeishuSync',
          'Explicitly download messages in [startTime,endTime) Unix seconds. Code paginates chat history then searches IDs and mgets originals in batches <=50. Resumes partial jobs; reuses complete ranges unless refresh=true. Only complete batches publish. Does not guarantee all historical replies. No index model or scheduled sync.',
          z.object({
            startTime: z.number().int().nonnegative(),
            endTime: z.number().int().nonnegative(),
            refresh: z.boolean().default(false),
          }),
          (input: any, caller: any) => sync.sync(input, caller),
        ],
        [
          'FeishuSyncStatus',
          'Read persisted download progress, errors and published ranges; does not download or organize an index.',
          z.object({ jobId: z.string().optional() }),
          async (input: any, caller: any) => {
            await verify(caller);
            return sync.status(input.jobId);
          },
        ],
      ] as const)
        ctx.tools.register({
          name,
          description,
          parameters,
          discovery: 'direct',
          categoryHint: name === 'FeishuSync' ? 'file_write' : 'read',
          executionSemantics: 'parallel',
          impl: async (input: any, call: any) =>
            JSON.parse(JSON.stringify(await impl(parameters.parse(input), { invocation: call }))),
        });
    },
  },
};
