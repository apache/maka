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

/** @param {import('../../../../packages/plugin-sdk/src/host.js').HostContext} ctx */
export default async function activate(ctx) {
  await ctx.remote.method('storage-budget', async () => {
    const mutations = Array.from({ length: 12 }, (_, index) => ({
      key: `budget/${index.toString().padStart(2, '0')}`,
      expectedRevision: null,
      data: { kind: /** @type {const} */ ('present'), value: 'x'.repeat(750_000) },
    }));
    mutations.push({
      key: 'budget-near',
      expectedRevision: null,
      data: { kind: 'present', value: 'n'.repeat(1024 * 1024 - 30) },
    });
    const written = await ctx.storage.batch(mutations);
    const near = await ctx.storage.read('budget-near');
    if (
      near?.data.kind !== 'present' ||
      typeof near.data.value !== 'string' ||
      near.data.value.length !== 1024 * 1024 - 30
    )
      throw new Error('large read was clipped');
    let total = 0;
    /** @type {string | undefined} */
    let after;
    do {
      const page = await ctx.storage.scan({ prefix: 'budget/', after });
      for (const entry of page.entries) {
        if (entry.record.data.kind !== 'present' || typeof entry.record.data.value !== 'string')
          throw new Error('invalid stored batch');
        total += entry.record.data.value.length;
      }
      after = page.nextAfter ?? undefined;
    } while (after);
    let conflict = false;
    try {
      await ctx.storage.batch([
        { key: 'uncommitted', expectedRevision: null, data: { kind: 'present', value: true } },
        { key: 'budget/00', expectedRevision: 99, data: { kind: 'deleted' } },
      ]);
    } catch {
      conflict = true;
    }
    if (!conflict || (await ctx.storage.read('uncommitted')) !== null)
      throw new Error('batch conflict published partial data');
    await ctx.storage.batch(
      mutations.map((mutation, index) => ({
        key: mutation.key,
        expectedRevision: written[index].revision,
        data: { kind: 'deleted' },
      })),
    );
    // Scan must budget escaped keys and record envelopes as well as SQL values.
    const escaped = Array.from({ length: 64 }, (_, index) => ({
      key: 'escaped/' + index.toString().padStart(2, '0') + '"'.repeat(1010),
      expectedRevision: null,
      data: { kind: /** @type {const} */ ('present'), value: 'v'.repeat(31600) },
    }));
    const rows = await ctx.storage.batch(escaped);
    const page = await ctx.storage.scan({ prefix: 'escaped/' });
    if (page.entries.length !== 64 || page.nextAfter)
      throw new Error('escaped-key scan was clipped');
    await ctx.storage.batch(
      escaped.map((entry, index) => ({
        key: entry.key,
        expectedRevision: rows[index].revision,
        data: { kind: 'deleted' },
      })),
    );
    return { written: written.length, bytes: total };
  });
  /** @type {import('../../../../packages/plugin-sdk/src/host.js').RemoteCaller | undefined} */
  let previousDatabase;
  const database = async (
    /** @type {import('../../../../packages/plugin-sdk/src/host.js').Json} */ input,
    /** @type {import('../../../../packages/plugin-sdk/src/host.js').RemoteCaller} */ caller,
  ) => {
    const request =
      /** @type {import('../../../../packages/plugin-sdk/src/host.js').DatabaseRead} */ (
        /** @type {unknown} */ (input)
      );
    if (previousDatabase) {
      try {
        await previousDatabase.views.queryDatabase(request);
        throw new Error('completed Remote call retained database authority');
      } catch (error) {
        if (error.code !== 'revoked') throw error;
      }
    }
    const tables = await caller.views.queryDatabase(request);
    previousDatabase = caller;
    return tables.map((table) => ({ ...table }));
  };
  await ctx.remote.method('database', database, { access: 'host_paths' });
  await ctx.remote.method(
    'database-summary',
    async (input, caller) => {
      const tables = await database(input, caller);
      return tables
        .flatMap((table) => table.rows)
        .reduce(
          (size, row) =>
            size +
            row.reduce((sum, cell) => sum + (cell.kind === 'text' ? cell.value.length : 0), 0),
          0,
        );
    },
    { access: 'host_paths' },
  );
  await ctx.remote.method('denied-database', database);
  await ctx.remote.method('uncertain', () => {
    /** @type {import('../../../../packages/plugin-sdk/src/host.js').RemoteFailure} */
    const failure = Object.assign(new Error('publication result needs recovery'), {
      code: /** @type {const} */ ('outcome_unknown'),
    });
    throw failure;
  });
  await ctx.remote.stream('uncertain-stream', () => ({
    next() {
      throw Object.assign(new Error('stream operation result needs recovery'), {
        code: 'outcome_unknown',
      });
    },
    cancel() {},
    close() {},
  }));
  /** @type {import('../../../../packages/plugin-sdk/src/host.js').RemoteCaller | undefined} */
  let previous;
  /** @type {import('../../../../packages/plugin-sdk/src/host.js').ReadDirectory | undefined} */
  let previousFiles;
  const workspace = async (
    /** @type {import('../../../../packages/plugin-sdk/src/host.js').Json} */ input,
    /** @type {import('../../../../packages/plugin-sdk/src/host.js').RemoteCaller} */ caller,
  ) => {
    if (typeof input !== 'string') throw new Error('expected workspace path');
    /** @type {import('../../../../packages/plugin-sdk/src/host.js').WorkspaceViewInput} */
    const request = {
      workspace: { kind: 'host_path', path: input },
      sandboxMode: 'read-only',
      collaborationMode: 'agent',
    };
    if (previous) {
      try {
        await previous.views.workspace(request);
        throw new Error('completed Remote call retained authority');
      } catch (error) {
        if (error.code !== 'revoked') throw error;
      }
    }
    if (previousFiles) {
      try {
        await previousFiles.list();
        throw new Error('completed Remote call retained filesystem authority');
      } catch (error) {
        if (error.code !== 'revoked') throw error;
      }
    }
    const view = await caller.views.workspace(request);
    await view.files.list({ limit: 1 });
    try {
      await view.files.read({ path: '../outside' });
      throw new Error('Remote read escaped its workspace');
    } catch (error) {
      if (error.code !== 'invalid') throw error;
    }
    previous = caller;
    previousFiles = view.files;
    return { cwd: view.workspace.hostCwd };
  };
  await ctx.remote.method('workspace', workspace, { access: 'host_paths' });
  await ctx.remote.method('denied-workspace', workspace);
  await ctx.remote.stream(
    'workspace-stream',
    (input, caller) => ({
      next: async () => ({ done: false, value: await workspace(input, caller) }),
      cancel() {},
      close() {},
    }),
    { access: 'host_paths' },
  );
  const state = { generation: 0, opening: 0, active: 0, stopped: 0 };
  /** @type {import('../../../../packages/plugin-sdk/src/host.js').TerminalView} */
  const terminalView = {
    version: 5,
    context: 'application',
    title: { fallback: 'Echo', translations: { 'zh-CN': '回显', 'zh-TW': '回顯' } },
  };
  let echo = await ctx.remote.method(
    'echo',
    (input, caller) => ({
      input,
      client: caller.clientInstanceId,
      session: caller.sessionId,
      generation: state.generation,
    }),
    { terminalView },
  );
  await ctx.remote.method('terminal-extra', () => null, {
    terminalView,
  });
  await ctx.remote.method('replace', async () => {
    await echo.close();
    state.generation++;
    echo = await ctx.remote.method('echo', (input) => ({ input, generation: state.generation }), {
      terminalView,
    });
    return true;
  });
  await ctx.remote.method('stats', () => ({ ...state }));
  await ctx.remote.stream('events', async (input, caller) => {
    state.opening++;
    if (input === 'late') await caller.signal.wait();
    state.opening--;
    state.active++;
    let cancelled = false;
    let index = 0;
    return {
      async next() {
        if (index++ === 0) return { done: false, value: null };
        await caller.signal.wait();
        return { done: true, value: undefined };
      },
      cancel() {
        if (!cancelled) state.stopped++;
        cancelled = true;
      },
      close() {
        if (!cancelled) throw new Error('close must follow cancellation');
        state.active--;
      },
    };
  });
}
