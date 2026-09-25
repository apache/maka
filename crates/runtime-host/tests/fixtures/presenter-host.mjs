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

let activations = 0;
export default async function activate(ctx) {
  activations++;
  let jobs = 0,
    ticks = 0;
  const requests = [];
  const receipts = new Map();
  const history = () =>
    ctx.tui.transcriptResource('history', {
      blocks: [
        {
          key: { turn: 'turn', message: 'message', part: 'text' },
          revision: '1',
          kind: 'assistant',
          content: { text: 'Shared business source' },
        },
      ],
    });
  let activity = await history();
  const changed = await ctx.tui.changes('changed');
  ctx.effect(() => activity.close());
  ctx.effect(() => changed.close());
  ctx.run(async () => {
    jobs++;
    while (!ctx.signal.aborted) {
      await ctx.sleep(1);
      ticks++;
    }
  });
  const backend = async (request, cx) => {
    requests.push({ request, document: cx.caller.documentId, client: cx.caller.clientInstanceId });
    if (request.kind === 'read') {
      if (request.route?.mode === 'large') return 'x'.repeat(65536);
      let denied = false;
      if (request.route?.mode === 'readonly') {
        try {
          await cx.caller.views.workspace({
            workspace: { kind: 'host_path', path: request.route.path },
            sandboxMode: 'danger-full-access',
            collaborationMode: 'agent',
          });
        } catch (error) {
          denied = String(error.message);
        }
      }
      return { request, denied };
    }
    const operation = request.route.operation;
    if (request.kind === 'recover') return receipts.get(operation) ?? { kind: 'unrecorded' };
    if (request.action === 'rejected') return { kind: 'rejected', message: 'Backend rejected' };
    const receipt = { kind: 'applied', route: { operation } };
    await ctx.storage.batch([
      {
        key: `receipts/${operation}`,
        expectedRevision: null,
        data: { kind: 'present', value: { request, receipt } },
      },
    ]);
    receipts.set(operation, receipt);
    return receipt;
  };
  await ctx.remote.method('stats', () => ({
    activations,
    jobs,
    ticks,
    requests,
    writes: receipts.size,
    resource: activity.resource,
    source: activity.stats,
  }));
  await ctx.remote.method('register-inline', async () => {
    try {
      await ctx.remote.method('inline', () => null, {
        terminalView: { version: 7, title: { fallback: 'Inline' }, context: 'application' },
      });
      return false;
    } catch {
      return true;
    }
  });
  await ctx.remote.method('register-forged-resource', async () => {
    try {
      await ctx.tui.app(
        'forged',
        { entry: 'ui.mjs', backend, resources: [{ ...activity.resource, id: 'forged' }] },
        { title: { fallback: 'Forged' }, context: 'application' },
      );
      return false;
    } catch {
      return true;
    }
  });
  await ctx.remote.method('register-invalid', async (entry) => {
    try {
      await ctx.tui.app(
        'invalid',
        { entry, backend },
        { title: { fallback: 'Invalid' }, context: 'application' },
      );
      return false;
    } catch {
      return true;
    }
  });
  await ctx.remote.method('replace-source', async () => {
    await activity.close();
    activity = await history();
    await ctx.tui.app(
      'dynamic',
      { entry: 'ui.mjs', backend, resources: [activity.resource] },
      { title: { fallback: 'Dynamic' }, context: 'application', changes: 'changed' },
    );
    return activity.resource;
  });
  await ctx.tui.app(
    'page',
    { entry: 'ui.mjs', backend, resources: [activity.resource] },
    { title: { fallback: 'Page' }, context: 'application', changes: 'changed' },
  );
}
