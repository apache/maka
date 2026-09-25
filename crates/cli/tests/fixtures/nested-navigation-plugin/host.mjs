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

export default async function activate(ctx) {
  const { tui } = ctx;
  let writes = 0;
  await ctx.remote.method('writes', () => writes);
  const source = (route) => {
    const value = route?.pane === 'details' ? route.context : route;
    if (
      typeof value?.assignmentId !== 'string' ||
      typeof value?.sourceSessionId !== 'string' ||
      Object.keys(value).length !== 2
    )
      throw new Error('Expected immutable WorkHub task context');
    return value;
  };
  const storageKey = (route) => `notes/${source(route).assignmentId}/${route.pane ?? 'base'}`;
  await tui.app(
    'nested-notes',
    {
      entry: 'nested-ui.mjs',
      async backend(submission) {
        if (submission.kind === 'read') {
          const context = source(submission.route);
          const record = await ctx.storage.read(storageKey(submission.route));
          const note = record?.data.kind === 'present' ? record.data.value : '';
          return { context, note, revision: record?.revision ?? null };
        }
        if (submission.kind !== 'submit') return { kind: 'unrecorded' };
        const key = storageKey(submission.route);
        const record = await ctx.storage.read(key);
        if (submission.revision !== String(record?.revision ?? 0)) return { kind: 'conflict' };
        await ctx.storage.batch([
          {
            key,
            expectedRevision: record?.revision ?? null,
            data: { kind: 'present', value: submission.fields.note },
          },
        ]);
        writes++;
        return { kind: 'applied', route: submission.route };
      },
    },
    {
      title: { fallback: 'Nested notes' },
      context: 'application',
      placement: { kind: 'slot', name: 'workhub.task.detail' },
    },
  );
}
