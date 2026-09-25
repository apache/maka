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

// One installed fixture supplies both the Host boundary and real TUI tests.
const operation = '__MUTATION_OPERATION__';

export default async function activate(ctx) {
  const { tui } = ctx;
  const recoveries = [];
  const reads = [];
  const value = (record) => (record?.data.kind === 'present' ? record.data.value : null);
  const load = async (id) => value(await ctx.storage.read(`operations/${id}`));
  await ctx.remote.method('stats', async () => ({
    business: value(await ctx.storage.read('business')),
    original: await load(operation),
    recoveries,
    reads,
  }));
  await tui.app(
    'terminal',
    {
      entry: 'mutation-ui.mjs',
      async backend(submission, cx) {
        if (submission.kind === 'read') {
          const route = submission.route;
          reads.push({ document: cx.caller.documentId, route });
          const original = await load(route?.done ? route.operation : operation);
          const sameRoute = original?.submission.action.startsWith('ui-same-route-') ?? false;
          return { operation, original: route?.done || sameRoute ? original : null, sameRoute };
        }
        if (submission.kind === 'recover') {
          const route = submission.route;
          recoveries.push(route.operation);
          return (await load(route.operation))?.receipt ?? { kind: 'unrecorded' };
        }
        if (submission.action === 'known-conflict') return { kind: 'conflict' };
        if (submission.action === 'known-rejected')
          return { kind: 'rejected', message: 'Nothing was written' };
        const id = submission.revision;
        const key = `operations/${id}`;
        const previous = await ctx.storage.read(key);
        const recorded = value(previous);
        if (recorded) {
          await ctx.storage.batch([
            {
              key,
              expectedRevision: previous.revision,
              data: {
                kind: 'present',
                value: { ...recorded, submissions: recorded.submissions + 1 },
              },
            },
          ]);
          return recorded.receipt;
        }
        const business = await ctx.storage.read('business');
        const receipt = {
          kind: 'applied',
          route: submission.action.startsWith('ui-same-route-')
            ? submission.route
            : { operation: id, done: true },
        };
        // The external SQL barrier observes this receipt only after the same
        // atomic batch has durably changed the business counter and original input.
        await ctx.storage.batch([
          {
            key,
            expectedRevision: null,
            data: {
              kind: 'present',
              value: { operation: id, submission, submissions: 1, receipt },
            },
          },
          {
            key: 'business',
            expectedRevision: business?.revision ?? null,
            data: { kind: 'present', value: { count: (value(business)?.count ?? 0) + 1 } },
          },
        ]);
        if (submission.action === 'runaway') {
          while (true) {
            /* The real Host watchdog terminates this VM after the durable write. */
          }
        }
        if (submission.action === 'throw') throw new Error('Failure after durable mutation');
        if (submission.action === 'cancel') {
          await cx.caller.signal.wait();
          throw Object.assign(new Error('Cancelled after durable mutation'), { code: 'cancelled' });
        }
        if (submission.action === 'oversized')
          return { kind: 'applied', route: { excess: 'x'.repeat(80 * 1024) } };
        return receipt;
      },
    },
    { title: { fallback: 'Mutation fault' }, context: 'application' },
  );
}
