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
import { test } from 'node:test';
import {
  hashSecret,
  verifySecret,
  generateTotpSecret,
  totpAt,
  verifyTotp,
  generateRecoveryCodes,
  toBase32,
} from '../crypto.js';

test('argon2id round-trips and rejects a wrong passphrase', async () => {
  const encoded = await hashSecret('correct horse battery staple');
  assert.match(encoded, /^argon2id\$/);
  assert.equal(await verifySecret('correct horse battery staple', encoded), true);
  assert.equal(await verifySecret('wrong', encoded), false);
});

test('RFC 6238 SHA-1 8-digit vector at T=59', () => {
  const secret = Buffer.from('12345678901234567890', 'ascii');
  assert.equal(totpAt(secret, 59, { digits: 8, period: 30 }), '94287082');
});

test('verifyTotp accepts current step and rejects replay of the same code', () => {
  const secret = generateTotpSecret();
  const now = Math.floor(Date.now() / 1000);
  const code = totpAt(secret, now, { digits: 6, period: 30 });
  const replay = new Set<string>();
  assert.equal(verifyTotp(secret, code, now, replay), true);
  assert.equal(verifyTotp(secret, code, now, replay), false);
});

test('recovery codes are 8 unique 10-char tokens', () => {
  const codes = generateRecoveryCodes();
  assert.equal(codes.length, 8);
  assert.equal(new Set(codes).size, 8);
  for (const code of codes) assert.match(code, /^[A-Z0-9]{10}$/);
});

test('toBase32 encodes the Hello vector', () => {
  assert.equal(toBase32(Buffer.from('Hello')), 'JBSWY3DP');
});
