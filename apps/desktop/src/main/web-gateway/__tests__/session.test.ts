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
import { generateTotpSecret, hashSecret, toBase32, totpAt } from '../../web-access/crypto.js';
import type { WebAccessFile } from '../../web-access/store.js';
import { createSessionTable, parseCookie, sessionCookieHeader, verifyLogin } from '../session.js';

const PASSPHRASE = 'twelve chars!!';

async function enrolledFile(overrides: Partial<WebAccessFile> = {}): Promise<{
  file: WebAccessFile;
  secret: Buffer;
}> {
  const secret = generateTotpSecret();
  const file: WebAccessFile = {
    version: 1,
    enabled: true,
    passphrase: await hashSecret(PASSPHRASE),
    totpSecret: toBase32(secret),
    recovery: [],
    totpConfirmed: true,
    ...overrides,
  };
  return { file, secret };
}

test('verifyLogin needs passphrase and TOTP; sets httpOnly cookie; ignores URL tokens', async () => {
  const { file, secret } = await enrolledFile();
  const table = createSessionTable();
  const now = Math.floor(Date.now() / 1000);
  const missingOtp = await verifyLogin({
    file,
    passphrase: PASSPHRASE,
    otp: '',
    now,
    table,
    clientAddress: '127.0.0.1',
  });
  assert.equal(missingOtp.ok, false);
  const ok = await verifyLogin({
    file,
    passphrase: PASSPHRASE,
    otp: totpAt(secret, now, { digits: 6, period: 30 }),
    now,
    table,
    clientAddress: '127.0.0.1',
  });
  assert.equal(ok.ok, true);
  if (!ok.ok) return;
  const header = sessionCookieHeader(ok.token, { secure: true });
  assert.match(header, /HttpOnly/i);
  assert.match(header, /SameSite=Strict/i);
  assert.match(header, /Secure/i);
  assert.equal(header.includes(ok.token), true);
  assert.equal(parseCookie(`maka_web_session=${ok.token}`), ok.token);
  assert.equal(parseCookie(`other=1; maka_web_session=${ok.token}; foo=bar`), ok.token);
});

test('verifyLogin lockout after 5 failures from one address', async () => {
  const { file, secret } = await enrolledFile();
  const table = createSessionTable();
  const now = Math.floor(Date.now() / 1000);
  for (let i = 0; i < 5; i++) {
    const result = await verifyLogin({
      file,
      passphrase: 'wrong-passphrase!!',
      otp: '000000',
      now,
      table,
      clientAddress: '10.0.0.8',
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, 'invalid');
  }
  const locked = await verifyLogin({
    file,
    passphrase: PASSPHRASE,
    otp: totpAt(secret, now, { digits: 6, period: 30 }),
    now,
    table,
    clientAddress: '10.0.0.8',
  });
  assert.equal(locked.ok, false);
  if (locked.ok) return;
  assert.equal(locked.reason, 'lockout');
});

test('verifyLogin rejects an enrolled file that is disabled', async () => {
  const { file, secret } = await enrolledFile({ enabled: false });
  const table = createSessionTable();
  const now = Math.floor(Date.now() / 1000);
  const result = await verifyLogin({
    file,
    passphrase: PASSPHRASE,
    otp: totpAt(secret, now, { digits: 6, period: 30 }),
    now,
    table,
    clientAddress: '127.0.0.1',
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, 'invalid');
});

test('verifyLogin accepts a recovery code and omits its hash from recoveryRemaining', async () => {
  const used = 'ABCDE12345';
  const keep = 'FGHIJ67890';
  const usedHash = await hashSecret(used);
  const keepHash = await hashSecret(keep);
  const { file } = await enrolledFile({ recovery: [usedHash, keepHash] });
  const table = createSessionTable();
  const now = Math.floor(Date.now() / 1000);
  const ok = await verifyLogin({
    file,
    passphrase: PASSPHRASE,
    otp: used,
    now,
    table,
    clientAddress: '127.0.0.1',
  });
  assert.equal(ok.ok, true);
  if (!ok.ok) return;
  assert.deepEqual(ok.recoveryRemaining, [keepHash]);
  assert.equal(ok.recoveryRemaining?.includes(usedHash), false);
});

test('verifyLogin still walks recovery hashes when the passphrase is wrong', async () => {
  const used = 'ABCDE12345';
  const keep = 'FGHIJ67890';
  const { file } = await enrolledFile({
    recovery: [await hashSecret(used), await hashSecret(keep)],
  });
  const table = createSessionTable();
  const now = Math.floor(Date.now() / 1000);
  const result = await verifyLogin({
    file,
    passphrase: 'wrong-passphrase!!',
    otp: used,
    now,
    table,
    clientAddress: '127.0.0.1',
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, 'invalid');
});

test('overlapping verifyLogin serializes lockout and TOTP replay', async () => {
  const { file, secret } = await enrolledFile();
  const now = Math.floor(Date.now() / 1000);
  const lockTable = createSessionTable();
  const overlapping = await Promise.all(
    Array.from({ length: 6 }, () =>
      verifyLogin({
        file,
        passphrase: 'wrong-passphrase!!',
        otp: '000000',
        now,
        table: lockTable,
        clientAddress: '10.0.0.8',
      }),
    ),
  );
  assert.equal(
    overlapping.filter((result) => !result.ok && result.reason === 'invalid').length,
    5,
  );
  assert.equal(
    overlapping.filter((result) => !result.ok && result.reason === 'lockout').length,
    1,
  );

  const replayTable = createSessionTable();
  const otp = totpAt(secret, now, { digits: 6, period: 30 });
  const replayed = await Promise.all([
    verifyLogin({
      file,
      passphrase: PASSPHRASE,
      otp,
      now,
      table: replayTable,
      clientAddress: '1.1.1.1',
    }),
    verifyLogin({
      file,
      passphrase: PASSPHRASE,
      otp,
      now,
      table: replayTable,
      clientAddress: '1.1.1.2',
    }),
  ]);
  assert.equal(replayed.filter((result) => result.ok).length, 1);
  const replayFail = replayed.find((result) => !result.ok);
  assert.ok(replayFail);
  if (!replayFail || replayFail.ok) return;
  assert.equal(replayFail.reason, 'invalid');
});
