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
import { isAbsolute } from 'node:path';
import { createFeishuSource } from './adapter.js';
export default {
  packageId: 'dev.maka.feishu-source',
  host: {
    name: 'feishu-source',
    inject: ['sources', 'credentials'],
    async apply(ctx: any, config: any = {}) {
      if (ctx.maka?.rootId !== 'profile') throw Error('Install feishu-source in profile scope');
      ctx.credentials.declare({ name: 'access-token', label: 'Feishu read access token' });
      const token = async () => {
        if (config.tokenFile) {
          if (!isAbsolute(config.tokenFile)) throw Error('tokenFile must be absolute');
          const info = await stat(config.tokenFile);
          if ((info.mode & 0o077) !== 0)
            throw Error('tokenFile must only be readable by its owner (chmod 600)');
          return (await readFile(config.tokenFile, 'utf8')).trim();
        }
        return ctx.credentials.use('access-token', (value: string) => value);
      };
      ctx.sources.register(
        createFeishuSource({ ...config, containers: JSON.parse(config.containers ?? '[]') }, token),
      );
    },
  },
};
