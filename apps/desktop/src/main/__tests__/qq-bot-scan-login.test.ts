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
import { createCipheriv, randomBytes } from 'node:crypto';
import { describe, test } from 'node:test';
import { decryptQQBotSecret } from '../qq-bot-scan-login.js';

describe('QQ Bot QR bind secret decryption', () => {
  test('decrypts the AES-256-GCM response envelope', () => {
    const key = randomBytes(32);
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const plaintext = 'qq-client-secret-value';
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const payload = Buffer.concat([iv, ciphertext, cipher.getAuthTag()]).toString('base64');

    assert.equal(decryptQQBotSecret(payload, key.toString('base64')), plaintext);
  });

  test('rejects malformed keys and truncated envelopes', () => {
    assert.throws(
      () => decryptQQBotSecret(Buffer.alloc(29).toString('base64'), Buffer.alloc(16).toString('base64')),
      /invalid encrypted secret/,
    );
    assert.throws(
      () => decryptQQBotSecret(Buffer.alloc(28).toString('base64'), Buffer.alloc(32).toString('base64')),
      /invalid encrypted secret/,
    );
  });
});
