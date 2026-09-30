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

import { CodexAppServerClient, EXECUTOR_ID, normalizeConfig } from './src/codex-app-server.mjs';

export {
  CodexAppServerClient,
  EXECUTOR_ID,
  normalizeConfig,
} from './src/codex-app-server.mjs';

export default Object.freeze({
  packageId: 'codex-app-server-executor',
  contributions: Object.freeze([Object.freeze({ id: EXECUTOR_ID, kind: 'executor' })]),
  host: Object.freeze({
    apply(ctx, value) {
      const config = normalizeConfig(value);
      const client = new CodexAppServerClient(config, ctx.logger('codex-app-server'));

      // Fiber effects unwind in reverse order. Own process cleanup first so the
      // executor retires and cancels its active calls before app-server closes.
      ctx.effect(() => () => client.close(), 'codex app-server process');
      ctx.clientBridge.rpc({
        name: 'codex.app-server.models',
        invoke: () => client.models(),
      });
      ctx.executors.register(
        Object.freeze({
          id: EXECUTOR_ID,
          displayName: 'Codex App Server',
          capabilities: Object.freeze({ thinking: true, toolActivity: true }),
          execute: (request, context) => client.execute(request, context),
        }),
      );
    },
  }),
});
