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

/**
 * Reading a response body without letting the far end decide how much memory
 * we spend. Every outbound fetch whose peer is not us belongs here.
 *
 * The bound is enforced twice because either check alone is a hole: the
 * declared `content-length` refuses an oversized body before a byte arrives,
 * and the running byte count refuses one that never declared a length or lied
 * about it. Buffering first and measuring afterwards is not a bound at all,
 * and `String.length` is not a byte count — a multi-byte body passes a limit
 * it exceeds by up to three times.
 */
export async function readBoundedResponseText(
  response: Response,
  maxBytes: number,
  overflow: () => Error,
): Promise<string> {
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    await response.body?.cancel();
    throw overflow();
  }
  if (!response.body) return '';

  const reader = response.body.getReader();
  const decoder = responseTextDecoder(response);
  let bytes = 0;
  let text = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel();
        throw overflow();
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

function responseTextDecoder(response: Response): TextDecoder {
  const contentType = response.headers.get('content-type') ?? '';
  const charset = /(?:^|;)\s*charset\s*=\s*"?([^;"\s]+)/i.exec(contentType)?.[1];
  if (!charset) return new TextDecoder();
  try {
    return new TextDecoder(charset);
  } catch {
    return new TextDecoder();
  }
}
