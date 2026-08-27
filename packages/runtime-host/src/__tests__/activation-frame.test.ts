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

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  decodeRuntimeHostActivationFrame,
  encodeRuntimeHostActivationFrame,
} from '../operator/activation-frame.js';

const result = {
  schemaVersion: 1,
  kind: 'result',
  deploymentId: '00000000-0000-4000-8000-000000000001',
  configRevision: 1,
  rootId: 'a'.repeat(64),
  hostEpoch: 'host-epoch',
  pid: 1234,
  protocolVersion: 1,
  endpoint: {
    host: '127.0.0.1',
    port: 43_210,
    websocketPath: '/runtime-host',
  },
} as const;

test('activation frames round-trip one strict bounded result', () => {
  assert.deepEqual(
    decodeRuntimeHostActivationFrame(encodeRuntimeHostActivationFrame(result)),
    result,
  );
});

test('activation frames reject unknown fields, non-loopback endpoints, and trailing frames', () => {
  const encode = (value: unknown) =>
    `MAKA_RUNTIME_HOST_ACTIVATION_V1 ${Buffer.from(JSON.stringify(value)).toString('base64url')}`;
  assert.equal(
    decodeRuntimeHostActivationFrame(encode({ ...result, credential: 'secret' })),
    undefined,
  );
  assert.equal(
    decodeRuntimeHostActivationFrame(
      encode({ ...result, endpoint: { ...result.endpoint, host: '0.0.0.0' } }),
    ),
    undefined,
  );
  assert.equal(
    decodeRuntimeHostActivationFrame(
      `${encode(result)}\n${encode({ schemaVersion: 1, kind: 'error', error: { code: 'x', message: 'x' } })}`,
    ),
    undefined,
  );
});
