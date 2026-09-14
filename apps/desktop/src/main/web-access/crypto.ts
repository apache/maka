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

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { argon2idAsync } from '@noble/hashes/argon2.js';

/** OWASP-friendly Argon2id params for JS (19 MiB). */
const ARGON_T = 2;
const ARGON_M = 19_456;
const ARGON_P = 1;
const ARGON_DK = 32;
const ARGON_SALT_LEN = 16;
/** Cap noble's u32 working set (~1 KiB per m unit). */
const ARGON_MAXMEM = ARGON_M * 1024;
const TOTP_DIGITS = 6;
const TOTP_PERIOD = 30;

function b64(data: Uint8Array): string {
  return Buffer.from(data).toString('base64url');
}

function fromB64(text: string): Buffer {
  return Buffer.from(text, 'base64url');
}

function digitsEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

export async function hashSecret(secret: string): Promise<string> {
  const salt = randomBytes(ARGON_SALT_LEN);
  const hash = await argon2idAsync(secret, salt, {
    t: ARGON_T,
    m: ARGON_M,
    p: ARGON_P,
    dkLen: ARGON_DK,
    maxmem: ARGON_MAXMEM,
  });
  return `argon2id$v=19$m=${ARGON_M},t=${ARGON_T},p=${ARGON_P}$${b64(salt)}$${b64(hash)}`;
}

export async function verifySecret(secret: string, encoded: string): Promise<boolean> {
  try {
    const match = /^argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([^$]+)\$([^$]+)$/.exec(encoded);
    if (!match) return false;
    const [, mText, tText, pText, saltB64, hashB64] = match;
    const m = Number(mText);
    const t = Number(tText);
    const p = Number(pText);
    if (m !== ARGON_M || t !== ARGON_T || p !== ARGON_P) return false;
    const salt = fromB64(saltB64!);
    const expected = fromB64(hashB64!);
    if (salt.length !== ARGON_SALT_LEN || expected.length !== ARGON_DK) return false;
    const actual = Buffer.from(
      await argon2idAsync(secret, salt, {
        t,
        m,
        p,
        dkLen: ARGON_DK,
        maxmem: ARGON_MAXMEM,
      }),
    );
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

export function generateTotpSecret(): Buffer {
  return randomBytes(20);
}

export function totpAt(
  secret: Buffer,
  unixSeconds: number,
  options: { digits: number; period: number },
): string {
  const counter = BigInt(Math.floor(unixSeconds / options.period));
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(counter);
  const hmac = createHmac('sha1', secret).update(msg).digest();
  const offset = hmac[hmac.length - 1]! & 0x0f;
  const bin =
    ((hmac[offset]! & 0x7f) << 24) |
    (hmac[offset + 1]! << 16) |
    (hmac[offset + 2]! << 8) |
    hmac[offset + 3]!;
  const mod = 10 ** options.digits;
  return String(bin % mod).padStart(options.digits, '0');
}

export function verifyTotp(
  secret: Buffer,
  code: string,
  unixSeconds: number,
  replay: Set<string>,
): boolean {
  const trimmed = code.trim();
  if (!/^\d{6}$/.test(trimmed)) return false;
  for (const skew of [-1, 0, 1]) {
    const at = totpAt(secret, unixSeconds + skew * TOTP_PERIOD, {
      digits: TOTP_DIGITS,
      period: TOTP_PERIOD,
    });
    const key = `${Math.floor((unixSeconds + skew * TOTP_PERIOD) / TOTP_PERIOD)}:${at}`;
    if (!digitsEqual(trimmed, at)) continue;
    if (replay.has(key)) return false;
    replay.add(key);
    return true;
  }
  return false;
}

export function generateRecoveryCodes(): string[] {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const codes: string[] = [];
  while (codes.length < 8) {
    const bytes = randomBytes(10);
    let token = '';
    for (const byte of bytes) token += alphabet[byte! % alphabet.length];
    token = token.slice(0, 10);
    if (!codes.includes(token)) codes.push(token);
  }
  return codes;
}

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function toBase32(data: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of data) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

export function fromBase32(text: string): Buffer {
  const clean = text.toUpperCase().replace(/=+$/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = BASE32.indexOf(ch);
    if (idx < 0) throw new Error('invalid-base32');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function otpauthUrl(secret: Buffer, account: string): string {
  return `otpauth://totp/Maka:${encodeURIComponent(account)}?secret=${toBase32(secret)}&issuer=Maka&period=30&digits=6&algorithm=SHA1`;
}
