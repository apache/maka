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

import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, readdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { ANTIGRAVITY_ACP_RELEASE } from '../../protocol/external-agent-setup.js';
import { AcpSetupError } from './connection.js';

const officialFiles = [
  ['agy_acp_server.par', '9d900b93031fc42397f88206e14eba4193729bbef631a70b18e7a19631a6dfac'],
  ['localharness_external', 'e0a8ef9d80a1ffb178f945159dda33f73d4a5be65516642542352584b834fa2a'],
] as const;

/** A pinned Google distribution only. The caller cannot supply URLs, argv or destinations. */
export async function installAntigravity(
  input: {
    directory: string;
    signal: AbortSignal;
    fetch: typeof globalThis.fetch;
    onProgress(phase: 'downloading' | 'installing', percent: number): void;
  },
  evidence: {
    archiveBytes: number;
    sha256: string;
    serverSha256: string;
    helperSha256: string;
  } = {
    ...ANTIGRAVITY_ACP_RELEASE,
    serverSha256: officialFiles[0][1],
    helperSha256: officialFiles[1][1],
  },
): Promise<string> {
  const files = [
    ['agy_acp_server.par', evidence.serverSha256],
    ['localharness_external', evidence.helperSha256],
  ] as const;
  const timeout = AbortSignal.timeout(15 * 60_000);
  const signal = AbortSignal.any([input.signal, timeout]);
  const destination = join(input.directory, ANTIGRAVITY_ACP_RELEASE.version);
  const previous = join(input.directory, `.${ANTIGRAVITY_ACP_RELEASE.version}.previous`);
  let staging: string | undefined;
  try {
    signal.throwIfAborted();
    await mkdir(input.directory, { recursive: true, mode: 0o700 });
    // Recover the only crash window in replacement publication: the verified
    // old directory was moved aside, but the verified new one was not yet named.
    try {
      await lstat(previous);
      try {
        await lstat(destination);
        await rm(previous, { recursive: true, force: true });
      } catch (error) {
        if (!hasCode(error, 'ENOENT')) throw error;
        await rename(previous, destination);
      }
    } catch (error) {
      if (!hasCode(error, 'ENOENT')) throw error;
    }
    // The Host serializes installer admission, so these can only belong to
    // attempts interrupted before their finally block ran.
    for (const name of await readdir(input.directory)) {
      signal.throwIfAborted();
      if (name.startsWith('.install-'))
        await rm(join(input.directory, name), { recursive: true, force: true });
    }
    try {
      await lstat(destination);
      await verifyInstallation(destination, signal, files);
      await setExecutablePermissions(destination, files);
      signal.throwIfAborted();
      return join(destination, files[0][0]);
    } catch (error) {
      signal.throwIfAborted();
      if (
        !(error instanceof AcpSetupError && error.failure === 'integrity_failed') &&
        !hasCode(error, 'ENOENT')
      )
        throw error;
    }
    staging = await mkdtemp(join(input.directory, '.install-'));
    const archive = join(staging, 'download.zip');
    const expanded = join(staging, 'runtime');
    input.onProgress('downloading', 0);
    const response = await input
      .fetch(ANTIGRAVITY_ACP_RELEASE.url, { signal, redirect: 'error' })
      .catch((error: unknown) => {
        if (signal.aborted) throw error;
        throw new AcpSetupError('download_failed');
      });
    if (!response.ok || !response.body) throw new AcpSetupError('download_failed');
    const hash = createHash('sha256');
    let bytes = 0;
    let percent = -1;
    await pipeline(
      Readable.fromWeb(response.body as import('node:stream/web').ReadableStream<Uint8Array>),
      new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          bytes += chunk.length;
          if (bytes > evidence.archiveBytes) {
            callback(new AcpSetupError('integrity_failed'));
            return;
          }
          hash.update(chunk);
          const next = Math.floor((bytes * 100) / evidence.archiveBytes);
          if (next !== percent) {
            percent = next;
            input.onProgress('downloading', percent);
          }
          callback(null, chunk);
        },
      }),
      createWriteStream(archive, { flags: 'wx', mode: 0o600 }),
      { signal },
    );
    if (bytes !== evidence.archiveBytes || hash.digest('hex') !== evidence.sha256)
      throw new AcpSetupError('integrity_failed');
    signal.throwIfAborted();
    input.onProgress('installing', 100);
    await mkdir(expanded, { mode: 0o700 });
    // Only the hash-verified archive is extracted. Bound cancellation until the child closes.
    await extract(archive, expanded, signal);
    await verifyInstallation(expanded, signal, files);
    await setExecutablePermissions(expanded, files);
    signal.throwIfAborted();
    await publishInstallation(expanded, destination, previous, signal, files);
    return join(destination, files[0][0]);
  } catch (error) {
    if (error instanceof AcpSetupError) throw error;
    if (timeout.aborted && !input.signal.aborted) throw new AcpSetupError('timed_out');
    if (input.signal.aborted) throw input.signal.reason;
    throw new AcpSetupError('installation_failed');
  } finally {
    if (staging) {
      try {
        await rm(staging, { recursive: true, force: true });
      } catch {
        throw new AcpSetupError('cleanup_failed');
      }
    }
  }
}

async function publishInstallation(
  expanded: string,
  destination: string,
  previous: string,
  signal: AbortSignal,
  files: readonly (readonly [string, string])[],
): Promise<void> {
  let displaced = false;
  try {
    await rename(destination, previous);
    displaced = true;
  } catch (error) {
    if (!hasCode(error, 'ENOENT')) throw error;
  }
  try {
    await rename(expanded, destination);
  } catch (error) {
    if (hasCode(error, 'EEXIST', 'ENOTEMPTY')) {
      try {
        await verifyInstallation(destination, signal, files);
      } catch (verificationError) {
        if (displaced) {
          await rm(destination, { recursive: true, force: true });
          await rename(previous, destination);
          displaced = false;
        }
        throw verificationError;
      }
    } else {
      if (displaced) {
        await rename(previous, destination);
        displaced = false;
      }
      throw error;
    }
  }
  if (displaced) await rm(previous, { recursive: true, force: true });
}

function hasCode(error: unknown, ...codes: string[]): boolean {
  return error instanceof Error && 'code' in error && codes.includes(String(error.code));
}

async function verifyInstallation(
  directory: string,
  signal: AbortSignal,
  files: readonly (readonly [string, string])[],
): Promise<void> {
  if (!(await lstat(directory)).isDirectory()) throw new AcpSetupError('integrity_failed');
  for (const [name, expected] of files) {
    signal.throwIfAborted();
    const path = join(directory, name);
    if (!(await lstat(path)).isFile()) throw new AcpSetupError('integrity_failed');
    const hash = createHash('sha256');
    await pipeline(createReadStream(path), hash, { signal });
    if (hash.digest('hex') !== expected) throw new AcpSetupError('integrity_failed');
  }
}
async function setExecutablePermissions(
  directory: string,
  files: readonly (readonly [string, string])[],
): Promise<void> {
  for (const [name] of files) await chmod(join(directory, name), 0o700);
}
async function extract(archive: string, destination: string, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const child = spawn('/usr/bin/unzip', ['-q', archive, '-d', destination], {
      stdio: 'ignore',
      shell: false,
    });
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let launchError = false;
    const abort = () => {
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), 1_000);
    };
    signal.addEventListener('abort', abort, { once: true });
    child.once('error', () => {
      launchError = true;
    });
    child.once('close', (code) => {
      signal.removeEventListener('abort', abort);
      clearTimeout(killTimer);
      if (signal.aborted) reject(signal.reason);
      else if (launchError || code !== 0) reject(new AcpSetupError('installation_failed'));
      else resolve();
    });
    if (signal.aborted) abort();
  });
}
