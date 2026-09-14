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

import { createRequire } from 'node:module';
import { hostname } from 'node:os';
import type { IpcMain } from 'electron';
import {
  fromBase32,
  generateRecoveryCodes,
  generateTotpSecret,
  hashSecret,
  otpauthUrl,
  toBase32,
  verifyTotp,
} from './crypto.js';
import { loadWebAccess, saveWebAccess, webAccessPath, type WebAccessFile } from './store.js';

const require = createRequire(import.meta.url);
const QRCode = require('qrcode') as { toDataURL(text: string): Promise<string> };

const PASSPHRASE_MIN_LENGTH = 12;

function emptyFile(): WebAccessFile {
  return {
    version: 1,
    enabled: false,
    passphrase: '',
    totpSecret: '',
    recovery: [],
    totpConfirmed: false,
  };
}

function isEnrolled(file: WebAccessFile | null): boolean {
  return Boolean(file?.passphrase && file.totpSecret && file.totpConfirmed);
}

export function registerWebAccessIpc(deps: {
  ipcMain: Pick<IpcMain, 'handle'>;
  userDataDir: string;
}): void {
  const path = webAccessPath(deps.userDataDir);
  const replay = new Set<string>();

  deps.ipcMain.handle('webAccess:getStatus', async () => {
    const file = await loadWebAccess(path);
    return { enrolled: isEnrolled(file), enabled: Boolean(file?.enabled) };
  });

  deps.ipcMain.handle('webAccess:setPassphrase', async (_e, input: { passphrase: string }) => {
    if (typeof input?.passphrase !== 'string' || input.passphrase.length < PASSPHRASE_MIN_LENGTH) {
      return { ok: false as const, reason: 'too-short' as const };
    }
    const existing = (await loadWebAccess(path)) ?? emptyFile();
    existing.passphrase = await hashSecret(input.passphrase);
    await saveWebAccess(path, existing);
    return { ok: true as const };
  });

  deps.ipcMain.handle('webAccess:enrollTotp', async () => {
    const existing = (await loadWebAccess(path)) ?? emptyFile();
    const secret = generateTotpSecret();
    existing.totpSecret = toBase32(secret);
    existing.enabled = false;
    existing.totpConfirmed = false;
    await saveWebAccess(path, existing);
    const otpauth = otpauthUrl(secret, hostname());
    return { otpauthUrl: otpauth, qrDataUrl: await QRCode.toDataURL(otpauth) };
  });

  deps.ipcMain.handle('webAccess:confirmTotp', async (_e, input: { code: string }) => {
    const existing = await loadWebAccess(path);
    if (!existing?.totpSecret) return { ok: false as const };
    let ok = false;
    try {
      ok = verifyTotp(
        fromBase32(existing.totpSecret),
        String(input?.code ?? ''),
        Math.floor(Date.now() / 1000),
        replay,
      );
    } catch {
      return { ok: false as const };
    }
    if (!ok) return { ok: false as const };
    existing.totpConfirmed = true;
    await saveWebAccess(path, existing);
    return { ok: true as const };
  });

  deps.ipcMain.handle('webAccess:setEnabled', async (_e, input: { enabled: boolean }) => {
    const existing = await loadWebAccess(path);
    if (!existing || !isEnrolled(existing)) return { ok: false as const, reason: 'not-enrolled' as const };
    existing.enabled = Boolean(input?.enabled);
    await saveWebAccess(path, existing);
    return { ok: true as const };
  });

  deps.ipcMain.handle('webAccess:regenerateRecovery', async () => {
    const existing = await loadWebAccess(path);
    if (!existing) return { codes: [] as string[] };
    const codes = generateRecoveryCodes();
    existing.recovery = await Promise.all(codes.map((code) => hashSecret(code)));
    await saveWebAccess(path, existing);
    return { codes };
  });
}
