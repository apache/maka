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

// Only the performance package installs this wrapper. The shared Board fixture
// activation is prepended as activateBoard in one import-free Host entrypoint.
export default async function activate(ctx) {
  let notify;
  let wake;
  let armed = false;
  let pending = false;
  let entered = 0;
  let released = 0;
  const status = () => ({ armed, pending, entered, released });
  await ctx.remote.method('read-control', (input) => {
    if (input.op === 'arm') {
      if (armed || pending) throw new Error('Read gate already armed');
      armed = true;
      notify();
    } else if (input.op === 'release') {
      armed = false;
      wake?.();
      wake = undefined;
    }
    return status();
  });
  const tui = {
    ...ctx.tui,
    async changes(name) {
      const changed = await ctx.tui.changes(name);
      if (name === 'board-changed') notify = changed;
      return changed;
    },
    async app(name, registration, descriptor, options) {
      return ctx.tui.app(
        name,
        {
          ...registration,
          async backend(request, cx) {
            if (request.kind === 'read' && armed) {
              armed = false;
              pending = true;
              entered++;
              await new Promise((resolve) => {
                wake = resolve;
              });
              pending = false;
              released++;
            }
            return registration.backend(request, cx);
          },
        },
        descriptor,
        options,
      );
    },
  };
  await activateBoard({ ...ctx, tui });
}
