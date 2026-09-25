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

(namespace, key, { builders, pick }) => {
  if (typeof namespace.default !== 'function') {
    throw new TypeError('A terminal entry must export a default page factory');
  }
  let initialized;
  let closed = false;
  const calls = new Map();
  return Object.freeze({
    async invoke(input, authority) {
      if (closed || typeof authority !== 'string' || calls.has(authority)) {
        throw new Error('Terminal invocation is retired or invalid');
      }
      let aborted = false;
      let wake;
      let used = false;
      const cancelled = new Promise((resolve) => {
        wake = resolve;
      });
      const cancel = () => {
        aborted = true;
        wake();
      };
      const signal = Object.freeze({
        get aborted() {
          return aborted || closed;
        },
        wait: () => cancelled,
        throwIfAborted() {
          if (this.aborted) throw new Error('Terminal invocation cancelled');
        },
      });
      calls.set(authority, cancel);
      try {
        initialized ??= Promise.resolve().then(() =>
          namespace.default(Object.freeze({ tui: builders })),
        );
        const handlers = await initialized;
        signal.throwIfAborted();
        const locale = input?.locale ?? 'en';
        const cx = Object.freeze({
          locale,
          t: (en, zhCN, zhTW) => pick(locale, en, zhCN, zhTW),
          signal,
          backend: (...args) => {
            if (args.length) throw new TypeError('backend() accepts no arguments');
            if (!calls.has(authority)) throw new Error('Terminal invocation is retired');
            signal.throwIfAborted();
            if (used) throw new Error('backend() may be called at most once');
            used = true;
            return Deno.core.ops.op_maka_plugin(key, 'page.backend', { authority });
          },
        });
        switch (input?.kind) {
          case 'read': {
            const result = await handlers.read(input.route ?? null, cx);
            return { kind: 'view', view: result?.version ? result : builders.view(result) };
          }
          case 'submit': {
            const { route = null, revision, action, fields = {}, grant = null } = input;
            return await handlers.submit({ route, revision, action, fields, grant }, cx);
          }
          case 'recover':
            if (typeof handlers.recover !== 'function') {
              throw new TypeError('This view declares no recovery');
            }
            return await handlers.recover(input.route ?? null, cx);
          default:
            throw new TypeError('Unknown terminal request');
        }
      } finally {
        calls.delete(authority);
        cancel();
      }
    },
    cancel(authority) {
      if (authority !== undefined) calls.get(authority)?.();
      else {
        closed = true;
        for (const cancel of calls.values()) cancel();
      }
    },
  });
};
