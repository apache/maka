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

import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { CodexSource } from './source.js';
import { CodexFileSource } from './file-source.js';

export default {
  packageId: 'dev.maka.codex-source',
  host: {
    name: 'codex-source',
    inject: ['sources', 'storage'],
    async apply(ctx: any, config: any = {}) {
      if (ctx.maka?.rootId !== 'profile') throw Error('Install Codex source in profile scope');
      const stored = async (name: string, initial: () => string) => {
        let record = await ctx.storage.get(name);
        if (record.value == null) {
          try {
            await ctx.storage.set(name, initial(), {
              expectedRevision: record.revision,
            });
          } catch {
            /* Re-read a concurrently initialized value. */
          }
          record = await ctx.storage.get(name);
        }
        if (typeof record.value !== 'string' || !record.value)
          throw Error(`Cannot initialize ${name}`);
        return record.value;
      };
      const directory = await stored(
        'data-directory',
        () =>
          config.dataDirectory ??
          join(homedir(), '.maka', 'plugin-data', 'dev.maka.codex-source', randomUUID()),
      );
      const home = config.codexHome ?? join(homedir(), '.codex');
      if (!isAbsolute(directory) || !isAbsolute(home)) throw Error('Codex paths must be absolute');
      const key = await stored('cursor-signing-key', () => randomBytes(32).toString('base64url'));
      const source = new CodexSource(home, config.startTime, directory, key);
      ctx.effect(() => () => source.close(), 'codex-source-cache');
      ctx.sources.register(source);
      const files: CodexFileSource[] = [];
      ctx.effect(() => () => files.forEach((item) => item.close()), 'codex-file-source-caches');
      if (config.memoriesEnabled === true) {
        const memories = new CodexFileSource(
          join(home, 'memories'),
          'memories',
          config.startTime,
          join(directory, 'memories'),
          key,
        );
        files.push(memories);
        ctx.sources.register(memories);
      }
      if (config.computerHistoryDirectory) {
        const activity = new CodexFileSource(
          config.computerHistoryDirectory,
          'computer-history',
          config.startTime,
          join(directory, 'computer-history'),
          key,
        );
        files.push(activity);
        ctx.sources.register(activity);
      }
    },
  },
};
