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

import { createHash } from 'node:crypto';

// Keep the complete record below Linux PIPE_BUF so merged Docker stdout/stderr
// cannot interleave inside an otherwise valid result frame.
const RESULT_PAYLOAD_LIMIT_BYTES = 2 * 1024;
const TOKEN_PATTERN = /^[0-9a-f]{32}$/u;

export function takeRelayResultToken(): string {
  const token = process.env.MAKA_EVAL_RESULT_TOKEN;
  delete process.env.MAKA_EVAL_RESULT_TOKEN;
  if (!token || !TOKEN_PATTERN.test(token)) throw new Error('relay result token is invalid');
  return token;
}

export function writeRelayResult(token: string, value: unknown): void {
  const payload = Buffer.from(JSON.stringify(value));
  if (payload.byteLength > RESULT_PAYLOAD_LIMIT_BYTES) {
    throw new Error('relay result exceeds the payload limit');
  }
  const digest = createHash('sha256').update(payload).digest('hex');
  process.stdout.write(
    `MAKA-EVAL-RESULT-V1 ${token} ${payload.byteLength} ${digest} ${payload.toString('base64url')}\n`,
  );
}
