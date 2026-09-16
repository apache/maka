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

const EMPTY_INPUT = Object.freeze({});

export default Object.freeze({
  packageId: 'maka.session-scratchpad',
  host: Object.freeze({
    apply(ctx, config) {
      const maxLength = normalizeMaxLength(config.maxLength);
      ctx.clientBridge.rpc({
        name: 'session-scratchpad.get',
        input: emptyInputSchema,
        output: noteSnapshotSchema,
        invoke: (_input, context) => readNote(ctx, requireSessionId(context)),
      });
      ctx.clientBridge.rpc({
        name: 'session-scratchpad.save',
        input: saveInputSchema(maxLength),
        output: noteSnapshotSchema,
        async invoke(input, context) {
          const sessionId = requireSessionId(context);
          const updatedAt = Date.now();
          const saved = await ctx.storage.set(
            noteKey(sessionId),
            { text: input.text, updatedAt },
            input.expectedRevision === undefined
              ? {}
              : { expectedRevision: input.expectedRevision },
          );
          return noteSnapshot(saved);
        },
      });
      ctx.clientBridge.stream({
        name: 'session-scratchpad.watch',
        input: emptyInputSchema,
        item: noteSnapshotSchema,
        open: (_input, context) => watchNote(ctx, requireSessionId(context), context.signal),
      });
    },
  }),
});

function normalizeMaxLength(value) {
  return Number.isSafeInteger(value) && value >= 256 && value <= 100000 ? value : 12000;
}

function requireSessionId(context) {
  if (typeof context.sessionId !== 'string' || context.sessionId.length === 0) {
    throw new TypeError('Session Scratchpad requires a Session-bound Client Remote call');
  }
  return context.sessionId;
}

function noteKey(sessionId) {
  return `sessions/${Buffer.from(sessionId, 'utf8').toString('base64url')}`;
}

async function readNote(ctx, sessionId) {
  return noteSnapshot(await ctx.storage.get(noteKey(sessionId)));
}

function noteSnapshot(snapshot) {
  const value = snapshot.value;
  return Object.freeze({
    revision: snapshot.revision,
    text: isNote(value) ? value.text : '',
    updatedAt: isNote(value) ? value.updatedAt : null,
  });
}

function isNote(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof value.text === 'string' &&
    Number.isSafeInteger(value.updatedAt) &&
    value.updatedAt >= 0
  );
}

async function* watchNote(ctx, sessionId, signal) {
  const key = noteKey(sessionId);
  let published = -1;
  let changed = 0;
  let wake;
  const stop = ctx.storage.watch((keys) => {
    if (!keys.includes(key)) return;
    changed += 1;
    wake?.();
  });
  const abort = () => wake?.();
  signal.addEventListener('abort', abort);
  try {
    while (!signal.aborted) {
      if (published !== changed) {
        published = changed;
        yield await readNote(ctx, sessionId);
        continue;
      }
      await new Promise((resolve) => {
        wake = resolve;
      });
      wake = undefined;
    }
  } finally {
    signal.removeEventListener('abort', abort);
    stop();
  }
}

const emptyInputSchema = schema((value) => {
  if (value === null || value === undefined) return EMPTY_INPUT;
  if (typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0) {
    return EMPTY_INPUT;
  }
  return undefined;
}, 'Expected an empty input object');

function saveInputSchema(maxLength) {
  return schema((value) => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
    if (!Object.hasOwn(value, 'text') || typeof value.text !== 'string') return undefined;
    if (value.text.length > maxLength) return undefined;
    const keys = Object.keys(value);
    if (keys.some((key) => key !== 'text' && key !== 'expectedRevision')) return undefined;
    if (
      value.expectedRevision !== undefined &&
      (!Number.isSafeInteger(value.expectedRevision) || value.expectedRevision < 0)
    ) {
      return undefined;
    }
    return Object.freeze({
      text: value.text,
      ...(value.expectedRevision === undefined ? {} : { expectedRevision: value.expectedRevision }),
    });
  }, `Expected text at most ${maxLength} characters and an optional revision`);
}

const noteSnapshotSchema = schema((value) => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  if (!Number.isSafeInteger(value.revision) || value.revision < 0) return undefined;
  if (typeof value.text !== 'string') return undefined;
  if (value.updatedAt !== null && (!Number.isSafeInteger(value.updatedAt) || value.updatedAt < 0)) {
    return undefined;
  }
  if (Object.keys(value).some((key) => !['revision', 'text', 'updatedAt'].includes(key))) {
    return undefined;
  }
  return value;
}, 'Expected a Session Scratchpad snapshot');

function schema(parse, message) {
  return Object.freeze({
    '~standard': Object.freeze({
      version: 1,
      vendor: 'maka.session-scratchpad',
      validate(value) {
        const parsed = parse(value);
        return parsed === undefined ? { issues: [{ message }] } : { value: parsed };
      },
    }),
  });
}
