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

// Independently installed task notes, bound only to WorkHub's immutable task
// identity. No WorkHub repository or execution authority crosses the slot.
export default async function activate(ctx) {
  const { tui } = ctx;
  const contexts = new Map();
  const reviewing = new Set();
  let reads = 0;
  let liveStreams = 0;
  // A public stream counts the actual observer owned by this
  // child. It has no relationship to WorkHub's session invalidations.
  const listeners = new Set();
  await ctx.remote.stream('notes-observation', () => {
    liveStreams++;
    let stopped = false;
    let dirty = false;
    let wake;
    const changed = () => {
      dirty = true;
      wake?.();
    };
    listeners.add(changed);
    return {
      async next() {
        while (!stopped && !dirty)
          await new Promise((resolve) => {
            wake = resolve;
          });
        dirty = false;
        return stopped ? { done: true, value: undefined } : { done: false, value: null };
      },
      cancel() {
        stopped = true;
        wake?.();
      },
      close() {
        listeners.delete(changed);
        liveStreams--;
      },
    };
  });
  const notify = () => {
    for (const listener of listeners) listener();
  };
  const load = async (id) => {
    const record = await ctx.storage.read(`notes/${id}`);
    return {
      revision: record?.revision ?? null,
      value: record?.data.kind === 'present' ? record.data.value : {},
    };
  };
  const store = async (id, record) => {
    await ctx.storage.batch([
      {
        key: `notes/${id}`,
        expectedRevision: record.revision,
        data: { kind: 'present', value: record.value },
      },
    ]);
    notify();
  };
  const task = (route) => {
    if (
      !route ||
      typeof route.assignmentId !== 'string' ||
      typeof route.sourceSessionId !== 'string' ||
      Object.keys(route).length !== 2
    ) {
      throw new Error('Expected immutable WorkHub task context');
    }
    return route.assignmentId;
  };
  await ctx.remote.method('stats', () => ({
    reads,
    liveStreams,
    contexts: [...contexts.values()],
  }));
  await ctx.remote.method('notes', async () => {
    const page = await ctx.storage.scan({ prefix: 'notes/' });
    return Object.fromEntries(
      page.entries.map(({ key, record }) => [key.slice(6), record.data.value]),
    );
  });
  await ctx.remote.method('review', async ({ assignmentId }) => {
    reviewing.add(assignmentId);
    notify();
    try {
      const record = await load(assignmentId);
      record.value.reviewed = true;
      await store(assignmentId, record);
    } finally {
      reviewing.delete(assignmentId);
      notify();
    }
    return null;
  });
  await tui.app(
    'notes-view',
    {
      entry: 'notes-ui.mjs',
      async backend(submission) {
        const id = task(submission.route);
        if (submission.kind === 'read') {
          contexts.set(id, submission.route);
          reads++;
          return { ...(await load(id)), busy: reviewing.has(id) };
        }
        if (submission.kind !== 'submit') return { kind: 'unrecorded' };
        const record = await load(id);
        if (submission.revision !== String(record.revision ?? 0)) return { kind: 'conflict' };
        record.value.note = submission.fields.note;
        await store(id, record);
        return { kind: 'applied', route: submission.route };
      },
    },
    {
      title: { fallback: 'Task notes', translations: { 'zh-CN': '任务备注', 'zh-TW': '任務備註' } },
      context: 'application',
      placement: { kind: 'slot', name: 'workhub.task.detail' },
      changes: 'notes-observation',
    },
  );
}
