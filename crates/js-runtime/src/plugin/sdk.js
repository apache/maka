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

(namespace, key) => {
  const activate = namespace.default;
  if (typeof activate !== 'function') {
    throw new TypeError('A Host plugin must export a default activation function');
  }
  const callbacks = new Map();
  const registrations = [];
  const cleanups = [];
  const jobs = [];
  const active = new Set();
  const invocations = new Map();
  const streams = new Map();
  let streamSequence = 0;
  const remoteResult = async (operation) => {
    try {
      return { kind: 'value', value: await operation() };
    } catch (error) {
      const code = ['invalid', 'revoked', 'cancelled', 'outcome_unknown', 'unavailable'].includes(
        error?.code,
      )
        ? error.code
        : 'unavailable';
      return { kind: 'error', code, message: String(error) };
    }
  };
  const closeStream = async (handle) => {
    const stream = streams.get(handle);
    if (!stream) return;
    stream.closing ??= (async () => {
      stream.cancel();
      await stream.pending?.catch(() => {});
      try {
        await stream.value.close();
      } finally {
        streams.delete(handle);
        invocations.delete(handle);
      }
    })();
    return stream.closing;
  };
  const readDirectory = (prefix, handle) =>
    Object.freeze({
      location: () => host(`${prefix}.location`, { handle }),
      read: async (input) => {
        const page = await host(`${prefix}.read`, { handle, input });
        return { ...page, bytes: Uint8Array.from(page.bytes) };
      },
      list: (input = {}) => host(`${prefix}.list`, { handle, input }),
      openFile: async (input) => {
        const opened = await host(`${prefix}.openFile`, { handle, input });
        return Object.freeze({
          info: Object.freeze(opened.info),
          read: async (input = {}) => {
            const page = await host('pinnedFile.read', { handle: opened.handle, input });
            return { ...page, bytes: Uint8Array.from(page.bytes) };
          },
          close: () => host('pinnedFile.close', { handle: opened.handle }),
        });
      },
      fileInfo: (input) => host(`${prefix}.fileInfo`, { handle, input }),
    });
  const processes = (authority) => {
    const open = (handle) =>
      Object.freeze({
        id: handle,
        write: (data) =>
          host('process.write', {
            authority,
            handle,
            bytes: Array.from(typeof data === 'string' ? new TextEncoder().encode(data) : data),
          }),
        endInput: () => host('process.endInput', { authority, handle }),
        next: async () => {
          const chunk = await host('process.next', { authority, handle });
          return chunk === null ? null : { ...chunk, bytes: Uint8Array.from(chunk.bytes) };
        },
        wait: () => host('process.wait', { authority, handle }),
        close: () => host('process.close', { handle }),
      });
    return Object.freeze({
      spawn: async (command) => open(await host('process.spawn', { command, authority })),
      open,
    });
  };
  const getService = async (name, authority) => {
    const handle = await host('service.get', { name });
    if (handle === null) return undefined;
    return Object.freeze({
      call: (input) => host('service.call', { handle, input, authority }),
      close: () => host('service.release', { handle }),
    });
  };
  const terminals = (authority) => {
    const open = (handle) =>
      Object.freeze({
        id: handle,
        write: (text, size) => host('terminal.control', { authority, handle, text, size }),
        resize: (size) => host('terminal.control', { authority, handle, size }),
        next: () => host('terminal.next', { authority, handle }),
        wait: () => host('terminal.wait', { authority, handle }),
        close: () => host('terminal.close', { handle }),
      });
    return Object.freeze({
      spawn: async (command, size = { cols: 80, rows: 24 }) =>
        open(await host('terminal.spawn', { authority, command, size })),
      open,
    });
  };
  const fileEntries = (invoke) =>
    Object.freeze({
      async read(input) {
        const page = await invoke('read', input);
        return { ...page, bytes: Uint8Array.from(page.bytes) };
      },
      write: (input) => invoke('write', { ...input, bytes: Array.from(input.bytes) }),
      list: (input = {}) => invoke('list', input),
      stat: (path) => invoke('stat', { path }),
      sync: (path = '') => invoke('sync', { path }),
      createDirectory: (path) => invoke('create_directory', { path }),
      remove: (path) => invoke('remove', { path }),
      rename: (from, to) => invoke('rename', { from, to }),
    });
  const files = (authority) =>
    Object.freeze({
      entries: fileEntries((kind, input) =>
        host('files.invoke', { authority, operation: { kind: 'entries', input: { kind, input } } }),
      ),
      ...Object.fromEntries(
        ['read', 'write', 'edit', 'glob', 'grep', 'patch'].map((kind) => [
          kind,
          async (input) => {
            const result = await host('files.invoke', { authority, operation: { kind, input } });
            return result.kind === 'image' && result.bytes
              ? { ...result, bytes: Uint8Array.from(result.bytes) }
              : result;
          },
        ]),
      ),
    });
  const http = (authority) =>
    Object.freeze({
      request: async ({ body, ...request }) => {
        const head = await host('http.request', {
          method: 'GET',
          ...request,
          authority,
          body: Array.from(
            typeof body === 'string' ? new TextEncoder().encode(body) : (body ?? []),
          ),
        });
        const { handle, ...metadata } = head;
        return Object.freeze({
          ...metadata,
          headers: head.headers.map(([name, value]) => [name, Uint8Array.from(value)]),
          next: async () => {
            const bytes = await host('http.next', { authority, handle });
            return bytes === null ? null : Uint8Array.from(bytes);
          },
          close: () => host('http.close', { handle }),
        });
      },
    });
  const tracked = async (task) => {
    const promise = Promise.resolve().then(task);
    active.add(promise);
    try {
      return await promise;
    } finally {
      active.delete(promise);
    }
  };
  let next = 0;
  let phase = 'new';
  let signalStop;
  const stopping = new Promise((resolve) => {
    signalStop = resolve;
  });
  const signal = Object.freeze({
    get aborted() {
      return phase === 'retired';
    },
    wait: () => stopping,
    throwIfAborted() {
      if (this.aborted) throw new Error('Plugin retired');
    },
  });
  const host = async (method, input) => {
    const reply = await Deno.core.ops.op_maka_plugin(key, method, input);
    if (reply.ok) return reply.value;
    throw Object.assign(new Error(reply.error.message), { code: reply.error.code });
  };
  const executionHandles = new WeakMap();
  const executions = (handle) => {
    const call = (method, input) => host(`execution.${method}`, { handle, input });
    let closing;
    const capability = Object.freeze({
      copyAttachment: (source, targetSessionId, attachment) => {
        const sourceHandle = executionHandles.get(source);
        if (sourceHandle === undefined) throw new TypeError('Expected a Host execution capability');
        return call('copyAttachment', { sourceHandle, targetSessionId, attachment });
      },
      resume: (input) => call('resume', input),
      configure: (input) => call('configure', input),
      removeSession: (input) => call('removeSession', input),
      removalReceipt: (sessionId) => call('removalReceipt', { sessionId }),
      previewRemoval: (sessionId) => call('previewRemoval', { sessionId }),
      input: (invocation) => call('input', invocation),
      readMessage: (input) => call('readMessage', input),
      enqueue: (input) => call('enqueue', input),
      message: (operationId) => call('message', { operationId }),
      retract: (operationId) => call('retract', { operationId }),
      offerInteraction: (input) => call('offerInteraction', input),
      interaction: (operationId) => call('interaction', { operationId }),
      waitInteraction: (operationId) => call('waitInteraction', { operationId }),
      closeInteraction: (operationId) => call('closeInteraction', { operationId }),
      submit: (input) => call('submit', input),
      session: (sessionId) => call('session', { sessionId }),
      capabilities: (sessionId) => call('capabilities', { sessionId }),
      activity: (sessionId) => call('activity', { sessionId }),
      stop: (invocation) => call('stop', invocation),
      restoreChild: (input) => call('restoreChild', input),
      createChild: (input) => call('createChild', input),
      createRoot: (input) => call('createRoot', input),
      importSession: (input) => call('importSession', input),
      restoreRoot: (operationId) => call('restoreRoot', { operationId }),
      abandonRevision: (operationId) => call('abandonRevision', { operationId }),
      workspacePatch: (operationId) => call('workspacePatch', { operationId }),
      query: (operationId) => call('query', { operationId }),
      cancel: (operationId) => call('cancel', { operationId }),
      events: (input) => call('events', input),
      event: (input) => call('event', input),
      artifact: (input) => call('artifact', input),
      close() {
        closing ??= host('execution.close', { handle });
        return closing;
      },
    });
    executionHandles.set(capability, handle);
    return capability;
  };
  const callback = (fn) => {
    if (typeof fn !== 'function' || callbacks.size >= 256 || next >= 0xffff_ffff) {
      throw new TypeError('Invalid callback or plugin callback limit exceeded');
    }
    const id = ++next;
    callbacks.set(id, fn);
    return id;
  };
  const register = async (kind, definition, fn) => {
    if (
      !['loading', 'prepared', 'active'].includes(phase) ||
      (phase === 'loading' && registrations.length >= 128)
    ) {
      throw new Error('Invalid contribution registration phase or capacity');
    }
    const descriptor = { ...definition, kind, callback: callback(fn) };
    let handle;
    if (phase === 'loading') {
      registrations.push(descriptor);
    } else {
      try {
        handle = await host('contribution.publish', [descriptor]);
      } catch (error) {
        callbacks.delete(descriptor.callback);
        throw error;
      }
    }
    let closing;
    return Object.freeze({
      close() {
        closing ??= (async () => {
          if (phase === 'loading') {
            const index = registrations.indexOf(descriptor);
            if (index >= 0) registrations.splice(index, 1);
            callbacks.delete(descriptor.callback);
          } else if (phase !== 'retired') {
            if (handle) await host('contribution.release', { handle });
            else
              await host('contribution.withdraw', {
                kind: kind === 'tool_group' ? 'tool' : kind,
                names:
                  kind === 'tool_group'
                    ? descriptor.tools.map((tool) => tool.name)
                    : [descriptor.name],
              });
          }
        })();
        return closing;
      },
    });
  };
  const text = (value) => (typeof value === 'function' ? value : () => value);
  const pricing = Object.freeze({ query: (input) => host('pricing.query', input) });
  const resources = (authority) => ({
    pricing: Object.freeze({
      ...pricing,
      update: (input) => host('pricing.update', { authority, input }),
    }),
    usage: Object.freeze({
      activity: (input) => host('usage.activity', { authority, input }),
      summary: (input) => host('usage.summary', { authority, input }),
    }),
    sessions: Object.freeze({ list: (input = {}) => host('sessions.list', { authority, input }) }),
    history: Object.freeze({
      list: (input = {}) => host('history.list', { authority, input }),
      read: (input) => host('history.read', { authority, input }),
      sources: (input) => host('history.sources', { authority, input }),
      copyMaterial: (target, input) => {
        const targetHandle = executionHandles.get(target);
        if (targetHandle === undefined) throw new TypeError('Expected a Host execution capability');
        return host('history.copyMaterial', { authority, targetHandle, input });
      },
      copySession: (target, input) => {
        const targetHandle = executionHandles.get(target);
        if (targetHandle === undefined) throw new TypeError('Expected a Host execution capability');
        return host('history.copySession', { authority, targetHandle, input });
      },
    }),
    executions: Object.freeze({
      open: async () => executions(await host('execution.acquire', { authority })),
    }),
    services: Object.freeze({ get: (name) => getService(name, authority) }),
    processes: processes(authority),
    terminals: terminals(authority),
    http: http(authority),
    permissions: Object.freeze({
      request: (request) => host('permissions.request', { authority, request }),
    }),
    files: files(authority),
    llm: Object.freeze({ generate: (input) => host('llm.generate', { authority, input }) }),
    clients: Object.freeze({
      notify: (input) => host('clients.notify', { authority, input }),
      tools: () => host('clients.tools', { authority }),
      call: (input) => host('clients.call', { authority, call: input }),
    }),
  });
  const authorized = async (opened, signal, callback) => {
    const { handle, source, grant, boundary } = await opened;
    try {
      return await callback(
        Object.freeze({ ...resources(handle), source, signal }),
        grant,
        boundary,
      );
    } finally {
      await host('authorization.close', { handle });
    }
  };

  // The store owns source data; each Remote document owns one immutable snapshot.
  // No page call can allocate a snapshot or borrow another document's fence.
  const transcriptResource = async (remote, name, initial = {}, options) => {
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const RECORD_BYTES = 16 * 1024 * 1024;
    const SOURCE_BYTES = 32 * 1024 * 1024;
    const WIRE_BYTES = 60 * 1024; // room for the enclosing Remote response
    const sources = new Map();
    const timings = new Map();
    const mounts = new Map();
    const counters = { opened: 0, closed: 0, invalidated: 0, pageReads: 0, updates: 0 };
    let sourceBytes = 0;
    let revision = 0;
    let mountSequence = 0;
    let closed = false;
    const fail = (message, code = 'invalid') => {
      throw Object.assign(new Error(message), { code });
    };
    const bytes = (value) => encoder.encode(value).length;
    const encodedSize = (value) => bytes(JSON.stringify(value));
    const safe = (value, multiline = false) =>
      typeof value === 'string' &&
      !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value) &&
      !(
        multiline
          ? /[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/u
          : /[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/u
      ).test(value);
    const identifier = (value) => {
      if (!safe(value) || !value.length || bytes(value) > 256) fail('Invalid transcript identity');
      return value;
    };
    const fields = (value, names) => {
      if (
        !value ||
        typeof value !== 'object' ||
        Array.isArray(value) ||
        Object.keys(value).some((key) => !names.includes(key))
      )
        fail('Invalid transcript fields');
    };
    const keyOf = (key) => {
      fields(key, ['turn', 'message', 'part']);
      identifier(key?.turn);
      identifier(key?.message);
      if (!['text', 'thinking', 'tool'].includes(key?.part)) fail('Invalid transcript part');
      return JSON.stringify([key.turn, key.message, key.part]);
    };
    const integer = (value) => Number.isSafeInteger(value) && value >= 0;
    const copyBlock = (input) => {
      const block = JSON.parse(JSON.stringify(input));
      fields(block, ['key', 'revision', 'kind', 'state', 'content', 'timestamp_ms', 'affinity']);
      const key = keyOf(block.key);
      identifier(block.revision);
      if (
        !['user', 'assistant', 'thinking', 'tool', 'failure', 'other', 'meta'].includes(block.kind)
      )
        fail('Invalid transcript kind');
      if (
        block.key.part !==
        (block.kind === 'tool' || block.kind === 'thinking' ? block.kind : 'text')
      )
        fail('Transcript kind does not match its key');
      const states = [
        'pending',
        'waiting',
        'returned',
        'attention',
        'failed',
        'timed_out',
        'cancelled',
        'completed',
        'missing',
      ];
      if (
        (block.kind === 'tool') !== (block.state != null) ||
        (block.state != null && !states.includes(block.state)) ||
        (block.affinity != null &&
          (block.kind !== 'tool' || !['read', 'search'].includes(block.affinity))) ||
        (block.timestamp_ms != null && !integer(block.timestamp_ms))
      )
        fail('Invalid transcript metadata');
      const content = block.content;
      fields(content, ['text', 'diff', 'link', 'emphasis']);
      if (!safe(content?.text, true)) fail('Invalid transcript text');
      const textBytes = encoder.encode(content.text);
      const range = (value) => {
        fields(value, ['start', 'end']);
        if (
          !value ||
          !integer(value.start) ||
          !integer(value.end) ||
          value.start >= value.end ||
          value.end > textBytes.length ||
          (textBytes[value.start] & 0xc0) === 0x80 ||
          (textBytes[value.end] & 0xc0) === 0x80
        )
          fail('Invalid transcript UTF-8 range');
      };
      if (
        content.diff !== undefined &&
        (!Array.isArray(content.diff) || content.diff.length > 131072)
      )
        fail('Invalid transcript diff');
      let end = 0;
      for (const row of content.diff ?? []) {
        fields(row, ['source', 'kind', 'language']);
        range(row.source);
        if (
          row.source.start < end ||
          !['removed', 'added', 'context', 'content'].includes(row.kind)
        )
          fail('Invalid transcript diff order');
        end = row.source.end;
        if (row.language != null && bytes(identifier(row.language)) > 64)
          fail('Invalid transcript language');
      }
      if (content.emphasis != null) range(content.emphasis);
      if (content.link != null) {
        fields(content.link, ['source', 'path']);
        range(content.link.source);
        const path = content.link.path;
        if (
          !safe(path) ||
          !path.trim() ||
          bytes(path) > 4096 ||
          path.includes('://') ||
          /[\u061c\u200e\u200f]/u.test(path)
        )
          fail('Invalid transcript link');
      }
      const json = JSON.stringify(block);
      const encoded = encoder.encode(json);
      if (encoded.length > RECORD_BYTES) fail('Transcript record exceeds 16 MiB');
      return { block, key, json, encoded, textBytes: textBytes.length };
    };
    const copyTiming = (input) => {
      const value = JSON.parse(JSON.stringify(input));
      fields(value, ['turn', 'start_ms', 'end', 'active']);
      if (value.end != null) fields(value.end, ['at_ms', 'outcome']);
      identifier(value.turn);
      if (
        !integer(value.start_ms) ||
        (value.active != null && typeof value.active !== 'boolean') ||
        (value.end != null &&
          (!integer(value.end.at_ms) ||
            value.end.at_ms < value.start_ms ||
            !['completed', 'failed', 'aborted'].includes(value.end.outcome) ||
            value.active))
      )
        fail('Invalid transcript timing');
      return value;
    };
    if (
      typeof name !== 'string' ||
      !/^[a-z][a-z0-9]*(?:[._:-][a-z0-9]+)*$/.test(name) ||
      name.length > 121
    )
      fail('Invalid transcript resource name');
    const resource = Object.freeze({
      id: name,
      read: `${name}.read`,
      stream: `${name}.stream`,
      route: null,
    });
    for (const block of initial.blocks ?? []) {
      const entry = copyBlock(block);
      if (sources.has(entry.key)) fail('Duplicate transcript key');
      sources.set(entry.key, entry);
      sourceBytes += entry.encoded.length;
      if (sources.size > 4096 || sourceBytes > SOURCE_BYTES)
        fail('Transcript source capacity exceeded');
    }
    for (const timing of initial.timings ?? []) {
      const value = copyTiming(timing);
      if (timings.has(value.turn)) fail('Duplicate transcript timing');
      timings.set(value.turn, value);
      if (timings.size > 4096) fail('Transcript timing capacity exceeded');
    }
    const owner = (caller) => {
      if (!caller?.documentId || !caller?.clientInstanceId)
        fail('Missing Remote document identity');
      caller.signal.throwIfAborted();
      return JSON.stringify([caller.clientInstanceId, caller.documentId, caller.sessionId]);
    };
    const recordAt = (entry, offset) => {
      if (offset === 0 && entry.encoded.length < 48 * 1024)
        return { record: { kind: 'block', block: entry.block }, next: entry.encoded.length };
      let end = Math.min(entry.encoded.length, offset + 8192);
      while (end < entry.encoded.length && (entry.encoded[end] & 0xc0) === 0x80) end--;
      return {
        record: {
          kind: 'fragment',
          key: entry.block.key,
          revision: entry.block.revision,
          offset,
          total: entry.encoded.length,
          json: decoder.decode(entry.encoded.subarray(offset, end)),
        },
        next: end,
      };
    };
    const invalidate = () => {
      for (const mount of [...mounts.values()]) mount.invalidate();
    };
    const publish = (makeEvents) => {
      if (closed) fail('Transcript resource is closed', 'revoked');
      if (!Number.isSafeInteger(revision + 1)) {
        invalidate();
        fail('Transcript revision exhausted');
      }
      const base = revision++;
      counters.updates++;
      for (const mount of [...mounts.values()]) mount.enqueue(makeEvents(base, revision));
    };
    const replaceEvents = function* (entry, append, base, revision) {
      let offset = 0;
      while (offset < entry.encoded.length) {
        const part = recordAt(entry, offset);
        yield { kind: 'replace', base, revision, append, record: part.record };
        offset = part.next;
      }
    };
    const put = (entry) => {
      if (closed) fail('Transcript resource is closed', 'revoked');
      const previous = sources.get(entry.key);
      if (previous?.json === entry.json) return false;
      if (previous?.block.revision === entry.block.revision)
        fail('Changed transcript needs a new revision');
      const size = sourceBytes - (previous?.encoded.length ?? 0) + entry.encoded.length;
      if ((!previous && sources.size >= 4096) || size > SOURCE_BYTES) {
        invalidate();
        fail('Transcript source capacity exceeded');
      }
      sources.set(entry.key, entry);
      sourceBytes = size;
      return true;
    };
    const page = (input, caller) => {
      const mount = mounts.get(owner(caller));
      if (closed || !mount || input?.resource !== name || input.fence !== mount.fence)
        fail('Transcript snapshot is no longer available', 'revoked');
      counters.pageReads++;
      return mount.page(input);
    };
    const open = (input, caller) => {
      const document = owner(caller);
      if (closed) fail('Transcript resource is closed', 'revoked');
      if (
        input?.resource !== name ||
        input.route !== null ||
        !safe(input.locale) ||
        !input.locale ||
        bytes(input.locale) > 32
      )
        fail('Invalid transcript open');
      if (mounts.has(document) || mounts.size >= 4) fail('Transcript document capacity exceeded');
      const fence = revision;
      let snapshot = [...sources.values()];
      let snapshotTimings = new Map(timings);
      const cursors = new Map();
      const cursorValues = new Map();
      const prefix = `m${++mountSequence}`;
      let queue = [{ kind: 'ready', fence }];
      let queueBytes = encodedSize(queue[0]);
      let live = true;
      let wake;
      const release = () => {
        if (live) {
          live = false;
          mounts.delete(document);
          counters.closed++;
          snapshot = [];
          snapshotTimings.clear();
          cursors.clear();
          cursorValues.clear();
        }
        wake?.();
      };
      const token = (value) => {
        const identity = JSON.stringify(value);
        let result = cursorValues.get(identity);
        if (!result) {
          if (cursors.size >= 8192) {
            mount.invalidate();
            fail('Transcript cursor capacity exceeded');
          }
          result = `${prefix}-c${cursors.size + 1}`;
          cursors.set(result, value);
          cursorValues.set(identity, result);
        }
        return result;
      };
      const mount = {
        fence,
        invalidate() {
          if (!live) return;
          counters.invalidated++;
          queue = [...queue.filter((event) => event.kind === 'ready'), { kind: 'invalidated' }];
          queueBytes = queue.reduce((total, event) => total + encodedSize(event), 0);
          release();
        },
        cancel() {
          queue = [];
          queueBytes = 0;
          release();
        },
        enqueue(events) {
          for (const event of events) {
            const size = encodedSize(event);
            if (size > WIRE_BYTES || queue.length >= 8192 || queueBytes + size > SOURCE_BYTES) {
              mount.invalidate();
              return;
            }
            queue.push(event);
            queueBytes += size;
          }
          wake?.();
        },
        page(input) {
          let spec;
          if (input.direction === 'tail' && input.cursor == null) {
            spec = { kind: 'older', boundary: snapshot.length };
          } else {
            spec = cursors.get(input.cursor);
            if (!spec || spec.kind !== input.direction) fail('Invalid transcript cursor');
          }
          let { start, end, index, offset = 0, timingIndex = 0 } = spec;
          if (spec.kind !== 'continue') {
            start = end = spec.boundary;
            let size = 0;
            if (spec.kind === 'older') {
              while (start > 0 && end - start < 256) {
                const next = snapshot[start - 1].encoded.length;
                if (size && size + next > 4 * 1024 * 1024) break;
                size += next;
                start--;
              }
            } else {
              while (end < snapshot.length && end - start < 256) {
                const next = snapshot[end].encoded.length;
                if (size && size + next > 4 * 1024 * 1024) break;
                size += next;
                end++;
              }
            }
            index = start;
          }
          const turns = new Set(snapshot.slice(start, end).map((entry) => entry.block.key.turn));
          const pageTimings = [...turns].map((turn) => snapshotTimings.get(turn)).filter(Boolean);
          const reply = {
            fence,
            records: [],
            timings: [],
            older: null,
            newer: null,
            continuation: null,
          };
          while (index < end && reply.records.length < 256) {
            const entry = snapshot[index];
            const part = recordAt(entry, offset);
            reply.records.push(part.record);
            if (encodedSize(reply) > WIRE_BYTES - 1024) {
              reply.records.pop();
              break;
            }
            offset = part.next;
            if (offset === entry.encoded.length) {
              index++;
              offset = 0;
            }
          }
          while (index === end && timingIndex < pageTimings.length) {
            reply.timings.push(pageTimings[timingIndex]);
            if (encodedSize(reply) > WIRE_BYTES - 1024) {
              reply.timings.pop();
              break;
            }
            timingIndex++;
          }
          if (index < end || timingIndex < pageTimings.length) {
            reply.continuation = token({
              kind: 'continue',
              start,
              end,
              index,
              offset,
              timingIndex,
            });
          } else {
            if (start > 0) reply.older = token({ kind: 'older', boundary: start });
            if (end < snapshot.length) reply.newer = token({ kind: 'newer', boundary: end });
          }
          return reply;
        },
      };
      // There is no await between snapshot capture and subscription registration.
      mounts.set(document, mount);
      counters.opened++;
      return {
        async next() {
          while (live && queue.length === 0) {
            await new Promise((resolve) => {
              wake = resolve;
            });
            wake = undefined;
          }
          if (!queue.length) return { done: true, value: undefined };
          const value = queue.shift();
          queueBytes -= encodedSize(value);
          return { done: false, value };
        },
        cancel: () => mount.cancel(),
        close: () => mount.cancel(),
      };
    };
    const reader = await remote.method(resource.read, page, options);
    let streamer;
    try {
      streamer = await remote.stream(resource.stream, open, options);
    } catch (error) {
      await reader.close();
      throw error;
    }
    let closing;
    return Object.freeze({
      resource,
      get stats() {
        return Object.freeze({ active: mounts.size, ...counters });
      },
      replace(block) {
        const entry = copyBlock(block);
        const append = !sources.has(entry.key);
        if (put(entry)) publish((base, revision) => replaceEvents(entry, append, base, revision));
      },
      append(key, text, blockRevision) {
        const previous = sources.get(keyOf(key));
        if (!previous || !safe(text, true) || !text) fail('Invalid transcript append');
        identifier(blockRevision);
        const entry = copyBlock({
          ...previous.block,
          revision: blockRevision,
          content: { ...previous.block.content, text: previous.block.content.text + text },
        });
        if (put(entry))
          publish((base, revision) => {
            const event = {
              kind: 'append',
              base,
              revision,
              key: entry.block.key,
              block_base: previous.block.revision,
              block_revision: blockRevision,
              offset: previous.textBytes,
              text,
            };
            return encodedSize(event) <= WIRE_BYTES
              ? [event]
              : replaceEvents(entry, false, base, revision);
          });
      },
      remove(key) {
        if (closed) fail('Transcript resource is closed', 'revoked');
        const identity = keyOf(key);
        const previous = sources.get(identity);
        if (!previous) return;
        sources.delete(identity);
        sourceBytes -= previous.encoded.length;
        publish((base, revision) => [{ kind: 'remove', base, revision, key: previous.block.key }]);
      },
      timing(input) {
        if (closed) fail('Transcript resource is closed', 'revoked');
        const value = copyTiming(input);
        if (!timings.has(value.turn) && timings.size >= 4096) {
          invalidate();
          fail('Transcript timing capacity exceeded');
        }
        if (JSON.stringify(timings.get(value.turn)) === JSON.stringify(value)) return;
        timings.set(value.turn, value);
        publish((base, revision) => [{ kind: 'timing', base, revision, timing: value }]);
      },
      close() {
        closing ??= (async () => {
          closed = true;
          for (const mount of [...mounts.values()]) mount.cancel();
          sources.clear();
          timings.clear();
          await Promise.all([reader.close(), streamer.close()]);
        })();
        return closing;
      },
    });
  };

  /** Terminal apps: a Remote method that answers terminal view requests,
   * with builders for the view tree the terminal renders. */
  const terminal = (remote) => {
    const pick = (locale, en, zhCN, zhTW) => {
      const language = String(locale ?? '').toLowerCase();
      if (language === 'zh-tw' || language === 'zh-hant') return zhTW ?? zhCN ?? en;
      if (language.startsWith('zh')) return zhCN ?? en;
      return en;
    };
    const view = ({ title, revision, fields = [], actions = [], root }) => ({
      version: 5,
      title,
      revision: String(revision),
      fields,
      actions,
      root,
    });
    const item = (key, title, target, extra = {}) => ({
      kind: 'item',
      key,
      title,
      target,
      ...extra,
    });
    const text = (key, value, tone = 'normal') => ({
      kind: 'text',
      key,
      spans: [{ text: String(value), tone }],
    });
    return Object.freeze({
      /** Serves `handlers` as the terminal view `descriptor` describes. */
      app: (name, handlers, descriptor, options = {}) =>
        remote.method(
          name,
          async (input, caller) => {
            const locale = input?.locale ?? 'en';
            const cx = Object.freeze({
              locale,
              caller,
              t: (en, zhCN, zhTW) => pick(locale, en, zhCN, zhTW),
            });
            switch (input?.kind) {
              case 'read': {
                const result = await handlers.read(input.route ?? null, cx);
                return { kind: 'view', view: result?.version ? result : view(result) };
              }
              case 'submit': {
                const { route = null, revision, action, fields = {}, grant = null } = input;
                return await handlers.submit({ route, revision, action, fields, grant }, cx);
              }
              case 'recover': {
                if (typeof handlers.recover !== 'function') {
                  throw Object.assign(new Error('This view declares no recovery'), {
                    code: 'invalid',
                  });
                }
                return await handlers.recover(input.route ?? null, cx);
              }
              default:
                throw Object.assign(new Error('Unknown terminal request'), { code: 'invalid' });
            }
          },
          { ...options, terminalView: { version: 5, ...descriptor } },
        ),
      /** A changes stream for a descriptor's `changes`; calling the
       * returned function tells every open view it is stale. */
      changes: async (name) => {
        const waiting = new Set();
        const registration = await remote.stream(name, () => {
          let pending = 0;
          let wake;
          const listener = () => {
            pending += 1;
            wake?.();
          };
          waiting.add(listener);
          let stopped = false;
          return {
            async next() {
              while (!stopped && pending === 0) {
                await new Promise((resolve) => {
                  wake = resolve;
                });
                wake = undefined;
              }
              if (stopped) return { done: true, value: undefined };
              pending = 0;
              return { done: false, value: null };
            },
            cancel() {
              stopped = true;
              waiting.delete(listener);
              wake?.();
            },
            close() {
              waiting.delete(listener);
            },
          };
        });
        const notify = () => {
          for (const listener of waiting) listener();
        };
        notify.close = () => registration.close();
        return notify;
      },
      transcriptResource: (name, initial, options) =>
        transcriptResource(remote, name, initial, options),
      transcript: (key, resource) => ({ kind: 'transcript', key, resource }),
      view,
      column: (key, children, gap = 1) => ({ kind: 'column', key, gap, children }),
      stack: (key, children) => ({ kind: 'column', key, gap: 0, children }),
      row: (key, children, gap = 2) => ({ kind: 'row', key, gap, children }),
      text,
      spans: (key, spans) => ({
        kind: 'text',
        key,
        spans: spans.map(([value, tone = 'normal']) => ({ text: String(value), tone })),
      }),
      heading: (key, value) => text(key, value, 'strong'),
      rule: (key) => ({ kind: 'rule', key }),
      scroll: (key, rows, child) => ({ kind: 'scroll', key, rows, child }),
      split: (key, ratio, left, right) => ({ kind: 'split', key, ratio, left, right }),
      tabs: (key, current, tabs) => ({ kind: 'tabs', key, current, tabs }),
      link: (key, title, route, extra) => item(key, title, { kind: 'route', route }, extra),
      act: (key, title, action, extra) => item(key, title, { kind: 'action', action }, extra),
      open: (key, title, session, extra) => item(key, title, { kind: 'session', session }, extra),
      button: (key, action, role = 'normal', label) => ({
        kind: 'button',
        key,
        action,
        role,
        ...(label === undefined ? {} : { label }),
      }),
      input: (key, field, label = '') => ({ kind: 'input', key, field, label }),
      progress: (key, value, max, label = '') => ({ kind: 'progress', key, value, max, label }),
      markdown: (key, value) => ({ kind: 'markdown', key, text: String(value) }),
      code: (key, value) => ({ kind: 'code', key, text: String(value) }),
      slot: (key, name, context = null) => ({ kind: 'slot', key, name, context }),
      action: (id, label, extra = {}) => ({ id, label, ...extra }),
      toggle: (id, value) => ({ id, control: { kind: 'toggle', value: Boolean(value) } }),
      line: (id, value = '', maxBytes = 256, extra = {}) => ({
        id,
        control: { kind: 'text', value: String(value), max_bytes: maxBytes, ...extra },
      }),
      area: (id, value = '', maxBytes = 8192, extra = {}) => ({
        id,
        control: {
          kind: 'text',
          value: String(value),
          max_bytes: maxBytes,
          multiline: true,
          ...extra,
        },
      }),
      choice: (id, value, options) => ({
        id,
        control: {
          kind: 'choice',
          value,
          options: options.map(([option, label]) => ({ value: option, label })),
        },
      }),
    });
  };
  return Object.freeze({
    async activate(identity, config) {
      if (phase !== 'new') throw new Error('Plugin already initialized');
      phase = 'loading';
      const remote = Object.freeze({
        method: (name, invoke, options) =>
          register('remote_method', { ...options, name }, (input, call) =>
            remoteResult(() => invoke(input, call)),
          ),
        stream: (name, open, options) =>
          register('remote_stream', { ...options, name }, (input, call) =>
            remoteResult(async () => {
              if (streams.size >= 32) throw new Error('Client stream capacity exceeded');
              const handle = 'stream-' + ++streamSequence;
              let stopped = false;
              let stop;
              const cancelled = new Promise((resolve) => {
                stop = resolve;
              });
              const stream = {
                value: undefined,
                pending: undefined,
                closing: undefined,
                cancelledValue: false,
                cancel() {
                  stopped = true;
                  stop();
                  if (stream.value && !stream.cancelledValue) {
                    stream.cancelledValue = true;
                    stream.value.cancel();
                  }
                },
              };
              const streamSignal = Object.freeze({
                get aborted() {
                  return stopped || call.signal.aborted;
                },
                wait: () => Promise.race([cancelled, call.signal.wait()]),
                throwIfAborted() {
                  if (this.aborted) throw new Error('Client stream cancelled');
                },
              });
              streams.set(handle, stream);
              invocations.set(handle, stream.cancel);
              try {
                stream.value = await open(input, Object.freeze({ ...call, signal: streamSignal }));
                if (
                  !stream.value ||
                  typeof stream.value.next !== 'function' ||
                  typeof stream.value.cancel !== 'function' ||
                  typeof stream.value.close !== 'function'
                ) {
                  throw new Error('Invalid Client stream');
                }
                if (stopped) stream.cancel();
                return handle;
              } catch (error) {
                streams.delete(handle);
                invocations.delete(handle);
                throw error;
              }
            }),
          ),
      });
      const context = Object.freeze({
        identity: Object.freeze(identity),
        signal,
        withAuthorization: (id, callback) =>
          authorized(host('authorization.open', { id }), signal, callback),
        input: Object.freeze({
          prepare: (name, prepare) =>
            register('input_preparation', { name }, (request, call) =>
              prepare(
                Object.freeze({ ...request, workspace: call.workspace, signal: call.signal }),
              ),
            ),
        }),
        tools: Object.freeze({
          register: (definition, invoke) => register('tool', definition, invoke),
          bind: (tools, capture) =>
            register('tool_group', { tools }, async (request, call) => {
              const bound = await capture(request, call);
              if (bound === null || bound === undefined) return null;
              const invokes = typeof bound.invoke === 'function';
              if (!invokes && !Object.keys(bound.providerTools ?? {}).length)
                throw new Error('Tool binding requires an invoke function or provider tools');
              return {
                callback: invokes
                  ? callback((input, invocation) =>
                      bound.invoke(input.name, input.input, invocation),
                    )
                  : 0,
                context: bound.context ?? null,
                providerTools: bound.providerTools ?? {},
              };
            }),
        }),
        executors: Object.freeze({
          search: (query = {}) => host('executors.search', query),
          register: (definition, execute) => register('executor', definition, execute),
        }),
        modelProviders: Object.freeze({
          register: (name, descriptor, provider) => {
            for (const method of ['resolve', 'authorize']) {
              if (typeof provider?.[method] !== 'function')
                throw new TypeError(`Model provider requires a ${method} method`);
            }
            return register('model_provider', { name, descriptor }, async (request, call) => {
              const method = provider[request.method];
              if (typeof method !== 'function') return { error: { kind: 'unavailable' } };
              try {
                return { value: (await method(request.input, call)) ?? null };
              } catch (error) {
                if (error?.providerFailure) return { error: error.providerFailure };
                throw error;
              }
            });
          },
        }),
        modelAdapters: Object.freeze({
          register: (name, open) =>
            register('model_adapter', { name }, async (lifetime) => {
              const session = await open(lifetime);
              if (typeof session?.stream !== 'function')
                throw new TypeError('Model adapter requires a stream method');
              const id = callback(async (request, call) => {
                try {
                  if (call.confirmation) await session.confirm?.(call.confirmation);
                  await session.stream(request, call);
                  return null;
                } catch (error) {
                  if (error?.modelFailure) return { error: error.modelFailure };
                  throw error;
                }
              });
              return { callback: id, confirmation: typeof session.confirm === 'function' };
            }),
        }),
        behaviors: Object.freeze({
          register: (name, prepare, options = {}) => {
            const nativeInput = options.nativeInput ?? 'denied';
            if (nativeInput !== 'denied' && nativeInput !== 'native_user_messages') {
              throw new TypeError('Invalid native input policy');
            }
            return register('behavior', { name, nativeInput }, prepare);
          },
        }),
        background: Object.freeze({
          pending: async (name, wake) => {
            let closed = false;
            const registration = await register('background', { name }, (_input, call) => {
              if (!closed) return wake(call.signal);
            });
            return Object.freeze({
              close() {
                closed = true;
                return registration.close();
              },
            });
          },
        }),
        remote,
        tui: terminal(remote),
        prompt: Object.freeze({
          section: (definition) => {
            const { text: value, ...metadata } = definition;
            return register('section', metadata, text(value));
          },
          variable: (name, value) => register('variable', { name }, text(value)),
          context: (definition) => {
            const { text: value, ...metadata } = definition;
            return register('context', metadata, text(value));
          },
        }),
        services: Object.freeze({
          provide: async (name, handler) => {
            const id = callback(handler);
            let handle;
            try {
              handle = await host('service.provide', { name, callback: id });
            } catch (error) {
              callbacks.delete(id);
              throw error;
            }
            let closing;
            return Object.freeze({
              close() {
                closing ??= host('contribution.release', { handle });
                return closing;
              },
            });
          },
          get: (name) => getService(name),
        }),
        storage: Object.freeze({
          read: (key) => host('storage.read', { key }),
          scan: (query = {}) => host('storage.scan', query),
          batch: (mutations) => host('storage.batch', { mutations }),
        }),
        models: Object.freeze({
          resolve: (selection) => host('models.resolve', selection),
          search: (query = {}) => host('models.search', query),
        }),
        pricing,
        async revision() {
          const handle = await host('revision', { kind: 'new' });
          let closed = false;
          return Object.freeze({
            async capture() {
              if (closed) throw new Error('Preparation revision is closed');
              return host('revision', { kind: 'capture', handle });
            },
            async invalidate(update) {
              if (closed) throw new Error('Preparation revision is closed');
              const guard = await host('revision', { kind: 'invalidate', handle });
              try {
                return await update();
              } finally {
                await host('revision', { kind: 'release', handle: guard });
              }
            },
            async close() {
              if (closed) return;
              await host('revision', { kind: 'close', handle });
              closed = true;
            },
          });
        },
        preferences: Object.freeze({
          read: () => host('preferences.read'),
        }),
        inputs: Object.freeze({
          names: () => host('inputs.names'),
          at: (name) => readDirectory('inputs', name),
        }),
        data: Object.freeze({
          ...fileEntries((kind, input) => host('data', { kind, input })),
          location: () => host('data.location'),
        }),
        credentials: Object.freeze({
          read: (key) => host('credentials.read', { key }),
          write: (input) => host('credentials.write', input),
        }),
        executions: Object.freeze({
          async restore(id) {
            return executions(await host('execution.restore', { id }));
          },
        }),
        sleep: (milliseconds) => host('clock.sleep', { milliseconds }),
        effect(dispose) {
          if (phase === 'retired' || typeof dispose !== 'function' || cleanups.length >= 128) {
            throw new Error('Invalid or retired cleanup registration');
          }
          cleanups.push(dispose);
        },
        run(task) {
          if (phase !== 'loading' || typeof task !== 'function' || jobs.length >= 64) {
            throw new Error('Business tasks must be staged during activation');
          }
          jobs.push(task);
        },
      });
      const dispose = await activate(context, config);
      if (phase !== 'loading') throw new Error('Plugin retired during initialization');
      if (dispose !== undefined) context.effect(dispose);
      phase = 'prepared';
      return registrations;
    },
    async invoke(id, input, call, invocation) {
      if (phase === 'retired') throw new Error('Plugin retired');
      const fn = callbacks.get(id);
      if (!fn) throw new Error('Plugin callback no longer exists');
      let abort;
      let aborted = false;
      const cancelled = new Promise((resolve) => {
        abort = resolve;
      });
      const cancel = () => {
        aborted = true;
        abort();
      };
      if (invocation !== undefined) invocations.set(invocation, cancel);
      const callSignal = Object.freeze({
        get aborted() {
          return aborted || signal.aborted;
        },
        wait: () => Promise.race([cancelled, stopping]),
        throwIfAborted() {
          if (this.aborted) throw new Error('Call cancelled');
        },
      });
      try {
        const context = { ...call, signal: callSignal };
        if (call?.readView) {
          context.workspace = readDirectory('view', call.readView);
        }
        if (call?.remoteAuthority) {
          context.views = Object.freeze({
            authorize: (request, callback) =>
              authorized(
                host('remote.authorize', { authority: call.remoteAuthority, request }),
                callSignal,
                callback,
              ),
            session: async () => {
              const view = await host('remote.session', { authority: call.remoteAuthority });
              return { ...view, files: readDirectory('view', view.files) };
            },
            workspace: async (input) => {
              const view = await host('remote.workspace', {
                authority: call.remoteAuthority,
                input,
              });
              return { ...view, files: readDirectory('view', view.files) };
            },
            queryDatabase: (input) =>
              host('remote.queryDatabase', { authority: call.remoteAuthority, input }),
          });
        }
        if (call?.authority) {
          Object.assign(context, resources(call.authority));
        }
        if (call?.executor) {
          context.emit = (output) => host('executor.emit', { handle: call.executor, output });
        }
        if (call?.model) {
          const io = async (kind, input) => {
            const result = await host('model.io', { handle: call.model, kind, input });
            if (result.error !== undefined) {
              throw Object.assign(new Error('Model transport operation failed'), {
                modelFailure: result.error,
              });
            }
            return result.value;
          };
          if (call.provider) {
            context.openExternal = (url, userCode) =>
              io('open_external', { url, user_code: userCode ?? null });
          } else {
            context.emit = (event) => io('emit', event);
            context.progress = () => io('progress');
          }
          context.transport = Object.freeze({
            identity: call.routing,
            async request(request) {
              const response = await io('request', {
                ...request,
                method: request.method ?? 'GET',
                body: Array.from(
                  typeof request.body === 'string'
                    ? new TextEncoder().encode(request.body)
                    : (request.body ?? []),
                ),
              });
              return Object.freeze({
                ...response.head,
                headers: response.head.headers.map(([name, bytes]) => [
                  name,
                  Uint8Array.from(bytes),
                ]),
                async next() {
                  const bytes = await io('read', response.id);
                  return bytes === null ? null : Uint8Array.from(bytes);
                },
                close: () => io('close_body', response.id),
              });
            },
            connect: (request) => io('connect', request),
            send: (socket, frame) =>
              io('send', {
                socket,
                frame: frame.kind === 'binary' ? { ...frame, data: Array.from(frame.data) } : frame,
              }),
            async receive(socket) {
              const frame = await io('receive', socket);
              return frame?.kind === 'binary'
                ? { ...frame, data: Uint8Array.from(frame.data) }
                : frame;
            },
            close: (socket) => io('close_socket', socket),
          });
        }
        return await tracked(() => fn(input, Object.freeze(context)));
      } finally {
        if (invocation !== undefined) invocations.delete(invocation);
      }
    },
    cancel(invocation) {
      invocations.get(invocation)?.();
    },
    async streamNext(handle) {
      const stream = streams.get(handle);
      if (!stream?.value || stream.closing || stream.pending)
        throw new Error('Client stream is closed or busy');
      const pending = remoteResult(() => tracked(() => stream.value.next()));
      stream.pending = pending;
      try {
        const outcome = await pending;
        if (outcome.kind === 'error') return outcome;
        const result = outcome.value;
        if (
          !result ||
          (result.done !== undefined && typeof result.done !== 'boolean') ||
          (!result.done && result.value === undefined)
        ) {
          throw new Error('Client stream returned an invalid iterator result');
        }
        return {
          kind: 'value',
          value: result.done ? { kind: 'end' } : { kind: 'item', value: result.value },
        };
      } finally {
        stream.pending = undefined;
      }
    },
    streamClose: closeStream,
    release(callback) {
      callbacks.delete(callback);
    },
    async effective() {
      if (phase !== 'prepared') throw new Error('Invalid effective transition');
      phase = 'active';
      const running = jobs.map((task) => tracked(task));
      jobs.length = 0;
      await Promise.all(running);
    },
    async retire() {
      phase = 'retired';
      signalStop();
      for (const stream of streams.values()) stream.cancel();
      await Promise.allSettled([...active]);
    },
    async dispose() {
      phase = 'retired';
      signalStop();
      const errors = [];
      for (const handle of streams.keys()) {
        try {
          await closeStream(handle);
        } catch (error) {
          errors.push(String(error));
        }
      }
      while (cleanups.length) {
        try {
          await cleanups.pop()();
        } catch (error) {
          errors.push(String(error));
        }
      }
      callbacks.clear();
      registrations.length = 0;
      if (errors.length) throw new Error(errors.join('; '));
    },
  });
};
