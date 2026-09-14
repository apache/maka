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
  fromBase32,
  otpauthUrl,
} from '../crypto.js';

test('argon2id round-trips and rejects a wrong passphrase', async () => {
  const encoded = await hashSecret('correct horse battery staple');
  assert.match(encoded, /^argon2id\$/);
  assert.match(encoded, /\$m=19456,t=2,p=1\$/);
  assert.equal(await verifySecret('correct horse battery staple', encoded), true);
  assert.equal(await verifySecret('wrong', encoded), false);
});

test('verifySecret returns false for malformed encodings without throwing', async () => {
  assert.equal(await verifySecret('x', 'not-a-hash'), false);
  assert.equal(
    await verifySecret(
      'x',
      'argon2id$v=19$m=999999999,t=2,p=1$aaaaaaaaaaaaaaaa$bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    ),
    false,
  );
  assert.equal(
    await verifySecret('x', 'argon2id$v=19$m=19456,t=2,p=1$YQ$YWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWE'),
    false,
  );
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

test('verifyTotp accepts ±1 step and rejects ±2', () => {
  const secret = generateTotpSecret();
  const now = Math.floor(Date.now() / 1000);
  const prev = totpAt(secret, now - 30, { digits: 6, period: 30 });
  const next = totpAt(secret, now + 30, { digits: 6, period: 30 });
  const tooOld = totpAt(secret, now - 60, { digits: 6, period: 30 });
  const tooNew = totpAt(secret, now + 60, { digits: 6, period: 30 });
  assert.equal(verifyTotp(secret, prev, now, new Set()), true);
  assert.equal(verifyTotp(secret, next, now, new Set()), true);
  assert.equal(verifyTotp(secret, tooOld, now, new Set()), false);
  assert.equal(verifyTotp(secret, tooNew, now, new Set()), false);
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

test('toBase32/fromBase32 round-trips a 20-byte secret', () => {
  const secret = Buffer.alloc(20, 0x5a);
  assert.deepEqual(fromBase32(toBase32(secret)), secret);
});

test('otpauthUrl embeds Maka issuer and base32 secret', () => {
  const secret = Buffer.from('12345678901234567890', 'ascii');
  const url = otpauthUrl(secret, 'user@example.com');
  assert.equal(
    url,
    'otpauth://totp/Maka:user%40example.com?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=Maka&period=30&digits=6&algorithm=SHA1',
  );
});
