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

import type { MakaClientRemoteRequest, MakaClientRemoteTransport } from './client-plugin-runtime.js';

/** A pull can be stopped without waiting for a quiet producer to yield again. */
export function remoteStream(
  transport: MakaClientRemoteTransport,
  request: MakaClientRemoteRequest,
  signals: readonly AbortSignal[],
): AsyncIterable<unknown> {
  let consumed = false;
  return {
    [Symbol.asyncIterator](): AsyncIterator<unknown> {
      if (consumed) throw new Error('Client Plugin Remote stream can only be consumed once');
      consumed = true;
      let closed = false;
      let aborted = false;
      let reason: unknown;
      let reading = false;
      let opening: Promise<string> | undefined;
      let streamId: string | undefined;
      let closeTask: Promise<void> | undefined;
      const pending = new Set<() => void>();
      const done = (): IteratorReturnResult<undefined> => ({ done: true, value: undefined });
      const closeRemote = () => {
        if (streamId && !closeTask) {
          const id = streamId;
          closeTask = Promise.resolve().then(() => transport.close({ streamId: id })).then(() => undefined, () => undefined);
        }
      };
      const interruptible = async <T,>(operation: Promise<T>): Promise<T | IteratorReturnResult<undefined>> => {
        if (closed) { void operation.catch(() => undefined); return done(); }
        let settle!: () => void;
        const stopped = new Promise<IteratorReturnResult<undefined>>(resolve => { settle = () => resolve(done()); });
        pending.add(settle);
        try { return await Promise.race([operation, stopped]); }
        finally { pending.delete(settle); }
      };
      const listeners = signals.map(signal => ({ signal, listener: () => stop(true, signal.reason) }));
      function stop(isAbort = false, error?: unknown): void {
        if (closed) return;
        closed = true;
        aborted = isAbort;
        reason = error;
        for (const { signal, listener } of listeners) signal.removeEventListener('abort', listener);
        for (const settle of pending) settle();
        pending.clear();
        closeRemote();
      }
      const terminal = () => {
        if (aborted) throw reason ?? new DOMException('Client Plugin stream aborted', 'AbortError');
        return done();
      };
      for (const { signal, listener } of listeners) {
        if (signal.aborted) { listener(); break; }
        signal.addEventListener('abort', listener, { once: true });
      }
      return {
        async next() {
          if (closed) return terminal();
          if (reading) throw new Error('Client Plugin Remote stream already has an active pull');
          reading = true;
          try {
            opening ??= transport.open(request).then(result => {
              streamId = result.streamId;
              if (closed) closeRemote();
              return streamId;
            });
            await interruptible(opening);
            if (closed) return terminal();
            const result = await interruptible(transport.next({ streamId: streamId! }));
            if (closed) return terminal();
            if (result.done) stop();
            return result.done ? done() : { done: false, value: result.value };
          } catch (error) {
            if (closed && aborted) return terminal();
            stop();
            throw error;
          } finally {
            reading = false;
          }
        },
        async return() { stop(); return done(); },
        async throw(error?: unknown) { stop(); throw error; },
      };
    },
  };
}
