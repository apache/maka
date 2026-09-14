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

import { createHash, randomBytes } from 'node:crypto';
import { fromBase32, verifySecret, verifyTotp } from '../web-access/crypto.js';
import type { WebAccessFile } from '../web-access/store.js';

const SESSION_COOKIE_NAME = 'maka_web_session';
const SESSION_TTL_SEC = 12 * 60 * 60;
const LOCKOUT_WINDOW_SEC = 15 * 60;
const LOCKOUT_PER_ADDRESS = 5;
const LOCKOUT_GLOBAL = 20;
const DUMMY_TOTP_SECRET = Buffer.alloc(20);
const tableQueues = new WeakMap<SessionTable, Promise<unknown>>();

export interface SessionTable {
  sessions: Map<string, { expiresAt: number }>;
  failuresByAddress: Map<string, number[]>;
  globalFailures: number[];
  totpReplay: Set<string>;
}

export type VerifyLoginResult =
  | { ok: false; reason: 'invalid' }
  | { ok: false; reason: 'lockout'; retryAfterSec: number }
  | { ok: true; token: string; recoveryRemaining?: string[] };

export function createSessionTable(): SessionTable {
  return {
    sessions: new Map(),
    failuresByAddress: new Map(),
    globalFailures: [],
    totpReplay: new Set(),
  };
}

export function sessionCookieHeader(token: string, options: { secure: boolean }): string {
  const parts = [
    `${SESSION_COOKIE_NAME}=${token}`,
    'Path=/',
    `Max-Age=${SESSION_TTL_SEC}`,
    'HttpOnly',
    'SameSite=Strict',
  ];
  if (options.secure) parts.push('Secure');
  return parts.join('; ');
}

export function expireCookieHeader(options: { secure: boolean }): string {
  const parts = [
    `${SESSION_COOKIE_NAME}=`,
    'Path=/',
    'Max-Age=0',
    'HttpOnly',
    'SameSite=Strict',
  ];
  if (options.secure) parts.push('Secure');
  return parts.join('; ');
}

export function parseCookie(header: string | undefined): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const name = part.slice(0, idx).trim();
    if (name !== SESSION_COOKIE_NAME) continue;
    return part.slice(idx + 1).trim();
  }
  return undefined;
}

export function lookupSession(table: SessionTable, token: string, now: number): boolean {
  const key = hashToken(token);
  const session = table.sessions.get(key);
  if (!session || session.expiresAt <= now) {
    table.sessions.delete(key);
    return false;
  }
  session.expiresAt = now + SESSION_TTL_SEC;
  return true;
}

export async function verifyLogin(input: {
  file: WebAccessFile;
  passphrase: string;
  otp: string;
  now: number;
  table: SessionTable;
  clientAddress: string;
}): Promise<VerifyLoginResult> {
  return serializeTable(input.table, () => verifyLoginLocked(input));
}

function serializeTable<T>(table: SessionTable, operation: () => Promise<T>): Promise<T> {
  const previous = tableQueues.get(table) ?? Promise.resolve();
  const run = previous.then(operation);
  tableQueues.set(
    table,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}

async function verifyLoginLocked(input: {
  file: WebAccessFile;
  passphrase: string;
  otp: string;
  now: number;
  table: SessionTable;
  clientAddress: string;
}): Promise<VerifyLoginResult> {
  const locked = lockoutRetryAfter(input.table, input.clientAddress, input.now);
  if (locked !== null) {
    return { ok: false, reason: 'lockout', retryAfterSec: locked };
  }

  const passOk = await verifySecret(input.passphrase, input.file.passphrase);
  const replayScratch = new Set(input.table.totpReplay);
  let totpOk = false;
  if (passOk) {
    totpOk = verifyFileTotp(input.file, input.otp, input.now, replayScratch);
  } else {
    verifyTotp(DUMMY_TOTP_SECRET, input.otp || '000000', input.now, new Set());
  }

  const remaining = await consumeRecovery(input.file.recovery, input.otp);
  let recoveryRemaining: string[] | undefined;
  if (passOk && !totpOk && remaining) {
    totpOk = true;
    recoveryRemaining = remaining;
  }

  if (!input.file.enabled || !passOk || !totpOk) {
    recordFailure(input.table, input.clientAddress, input.now);
    return { ok: false, reason: 'invalid' };
  }

  input.table.totpReplay = replayScratch;
  const token = randomBytes(32).toString('base64url');
  input.table.sessions.set(hashToken(token), { expiresAt: input.now + SESSION_TTL_SEC });
  input.table.failuresByAddress.delete(input.clientAddress);
  return recoveryRemaining
    ? { ok: true, token, recoveryRemaining }
    : { ok: true, token };
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function verifyFileTotp(
  file: WebAccessFile,
  otp: string,
  now: number,
  replay: Set<string>,
): boolean {
  try {
    return verifyTotp(fromBase32(file.totpSecret), otp, now, replay);
  } catch {
    return false;
  }
}

async function consumeRecovery(hashes: string[], otp: string): Promise<string[] | undefined> {
  let matched: string | undefined;
  for (const hash of hashes) {
    if (await verifySecret(otp, hash)) matched = hash;
  }
  if (!matched) return undefined;
  const remaining = hashes.filter((hash) => hash !== matched);
  return remaining;
}

function pruneFailures(times: number[], now: number): number[] {
  return times.filter((stamp) => now - stamp < LOCKOUT_WINDOW_SEC);
}

function retryAfterSec(times: number[], now: number, limit: number): number | null {
  const window = pruneFailures(times, now);
  if (window.length < limit) return null;
  const oldest = Math.min(...window);
  return Math.max(1, oldest + LOCKOUT_WINDOW_SEC - now);
}

function lockoutRetryAfter(table: SessionTable, clientAddress: string, now: number): number | null {
  const perAddress = retryAfterSec(
    table.failuresByAddress.get(clientAddress) ?? [],
    now,
    LOCKOUT_PER_ADDRESS,
  );
  const global = retryAfterSec(table.globalFailures, now, LOCKOUT_GLOBAL);
  if (perAddress === null && global === null) return null;
  return Math.max(perAddress ?? 0, global ?? 0);
}

function recordFailure(table: SessionTable, clientAddress: string, now: number): void {
  const prior = pruneFailures(table.failuresByAddress.get(clientAddress) ?? [], now);
  prior.push(now);
  table.failuresByAddress.set(clientAddress, prior);
  table.globalFailures = pruneFailures(table.globalFailures, now);
  table.globalFailures.push(now);
}
