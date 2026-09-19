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

/** A provider EOF before completion must use the model loop's truncated-stream retry. */
export class TraeStreamTruncatedError extends Error {
  readonly code = 'TRAE_STREAM_TRUNCATED';
}

/** Bounded incremental SSE decoding, including split UTF-8, CRLF and multiline data. */
export async function* traeSse(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<{ event: string; data: unknown }> {
  const reader = body.getReader();
  const onAbort = () => {
    void reader.cancel(signal?.reason).catch(() => undefined);
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  const decoder = new TextDecoder();
  let buffer = '';
  let event = 'message';
  let data: string[] = [];
  let frameSize = 0;
  let ended = false;
  const line = (text: string) => {
    if (!text) {
      if (!data.length) {
        event = 'message';
        frameSize = 0;
        return undefined;
      }
      const known = [
        'output',
        'metadata',
        'token_usage',
        'done',
        'error',
        'queue_begin',
        'request_wait_in_queue',
        'queue_end',
      ].includes(event);
      const payload = data.join('\n');
      const frame =
        payload === '[DONE]'
          ? { event: 'done', data: {} }
          : { event, data: known ? (JSON.parse(payload) as unknown) : {} };
      event = 'message';
      data = [];
      frameSize = 0;
      return frame;
    }
    frameSize += text.length;
    if (frameSize > 4 * 1024 * 1024) throw new Error('Trae stream frame exceeded its limit');
    if (text.startsWith('event:')) event = text.slice(6).trim();
    if (text.startsWith('data:')) data.push(text.slice(5).replace(/^ /, ''));
    return undefined;
  };
  try {
    while (!ended) {
      signal?.throwIfAborted();
      const next = await reader.read();
      signal?.throwIfAborted();
      ended = next.done;
      buffer += decoder.decode(next.value, { stream: !ended });
      let index: number;
      while ((index = buffer.indexOf('\n')) !== -1) {
        const frame = line(buffer.slice(0, index).replace(/\r$/, ''));
        buffer = buffer.slice(index + 1);
        if (frame) yield frame;
      }
      if (buffer.length > 4 * 1024 * 1024) throw new Error('Trae stream frame exceeded its limit');
    }
    if (buffer.trim() || data.length)
      throw new TraeStreamTruncatedError('Trae stream ended with an incomplete frame');
  } finally {
    signal?.removeEventListener('abort', onAbort);
    if (!ended) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
