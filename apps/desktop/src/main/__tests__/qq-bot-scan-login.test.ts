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
