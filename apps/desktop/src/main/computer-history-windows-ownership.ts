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

import type { BigIntStats } from 'node:fs';
import { lstat } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import { win32 } from 'node:path';

type HomeIdentity = Pick<BigIntStats, 'dev' | 'ino' | 'isDirectory' | 'isSymbolicLink'>;

interface OwnershipDependencies {
  lstat?: (path: string) => Promise<HomeIdentity>;
  createServer?: () => Server;
}

/**
 * Windows-only, main-process admission; no helper or client connection owns it.
 * The caller must keep the existing home directory stable throughout maintenance.
 * Supported homes are local NTFS directories, not mapped/network drives, FAT,
 * ReFS or directories with reparse-point ancestors. Node cannot verify the
 * filesystem type or expose every reparse tag; the native validator remains
 * authoritative. Here lstat rejects symlinks/junctions before and after binding.
 * This is not a cross-machine lock or an authorization boundary. Node uses the
 * default pipe DACL and does not reject remote clients, so no data is exchanged.
 *
 * Native contenders use GetFileInformationByHandle on the validated directory:
 * dev = dwVolumeSerialNumber, ino = (uint64_t(nFileIndexHigh) << 32) | nFileIndexLow.
 * Format both as lowercase, unpadded hex and use FILE_FLAG_FIRST_PIPE_INSTANCE.
 */
export async function acquireWindowsHistoryOwnership(
  home: string,
  dependencies: OwnershipDependencies = {},
): Promise<{ close(): Promise<void> }> {
  const lstatHome = dependencies.lstat ?? ((path: string) => lstat(path, { bigint: true }));
  const path = ownershipPipeName(await readHomeIdentity(home, lstatHome));
  const server = (dependencies.createServer ?? createServer)();
  let serverError: Error | undefined;
  // A server error does not close its handle. Keep admission held and report
  // the failure at release instead of crashing main or silently giving it up.
  server.on('error', (error) => { serverError ??= error; });
  server.on('connection', (socket) => {
    socket.on('error', () => {});
    socket.destroy();
  });

  let closeTask: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closeTask ??= new Promise<void>((resolve, reject) => {
      server.close((error?: NodeJS.ErrnoException) => {
        if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') reject(error);
        else if (serverError) reject(serverError);
        else resolve();
      });
    });
    return closeTask;
  };

  try {
    await listen(server, path);
    if (ownershipPipeName(await readHomeIdentity(home, lstatHome)) !== path) {
      throw new Error('Computer History home changed while acquiring Windows ownership');
    }
    if (serverError) throw serverError;
    return { close };
  } catch (error) {
    await close();
    throw error;
  }
}

async function readHomeIdentity(
  home: string,
  lstatHome: (path: string) => Promise<HomeIdentity>,
): Promise<HomeIdentity> {
  const root = win32.parse(home).root.replaceAll('/', '\\');
  if (!/^(?:\\\\\?\\)?[a-z]:\\$/i.test(root)) {
    throw new Error('Computer History home must be an absolute local drive path');
  }
  let identity: HomeIdentity | undefined;
  for (let directory = home; ; directory = win32.dirname(directory)) {
    const metadata = await lstatHome(directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error('Computer History home and ancestors must be real directories');
    }
    identity ??= metadata;
    if (win32.dirname(directory) === directory) return identity;
  }
}

function ownershipPipeName(identity: HomeIdentity): string {
  if (!identity.isDirectory() || identity.dev <= 0n || identity.dev > 0xffff_ffffn ||
      identity.ino <= 0n || identity.ino > 0xffff_ffff_ffff_ffffn) {
    throw new Error('Computer History home has no supported Windows directory identity');
  }
  return `\\\\.\\pipe\\maka-history-${identity.dev.toString(16)}-${identity.ino.toString(16)}`;
}

function listen(server: Server, path: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      server.off('error', onError);
      server.off('listening', onListening);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onListening = () => {
      cleanup();
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    try {
      // libuv's Windows bind uses FIRST_PIPE_INSTANCE. exclusive disables
      // Node cluster handle sharing; it is not the Win32 exclusion flag.
      server.listen({ path, exclusive: true });
    } catch (error) {
      cleanup();
      reject(error);
    }
  });
}
