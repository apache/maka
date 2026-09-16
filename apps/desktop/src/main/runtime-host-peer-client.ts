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

import { randomUUID } from 'node:crypto';
import { access, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  decodeRuntimeHostWebRtcStunPolicy,
  resolveRuntimeHostWebRtcStunUrls,
  type RuntimeHostWebRtcStunPolicy,
} from '@maka/runtime-host/client';
import { syncDirectory } from '@maka/storage/stable-storage';

const NATIVE_FILE = 'maka_runtime_host_peer.node';
const CONNECTIVITY_POLICY_FILE = 'runtime-host-peer-connectivity.json';
const CONNECTIVITY_POLICY_MAX_BYTES = 16 * 1024;

export async function configureDesktopRuntimeHostPeerClient(input: {
  readonly isPackaged: boolean;
  readonly enableDevelopmentPeer?: boolean;
  readonly appPath: string;
  readonly resourcesPath: string;
  readonly clientDataRoot: string;
  readonly environment?: NodeJS.ProcessEnv;
}): Promise<{
  readonly nativePath: string;
  readonly keyPath: string;
  readonly automaticRelayDiscovery: true;
  readonly webRtcStunUrls: readonly string[];
  readonly webRtcStunPolicy: RuntimeHostWebRtcStunPolicy;
} | undefined> {
  const environment = input.environment ?? process.env;
  const explicitNativePath = environment.MAKA_RUNTIME_HOST_PEER_NATIVE_PATH?.trim();
  const explicitKeyPath = environment.MAKA_RUNTIME_HOST_PEER_KEY_PATH?.trim();
  const webRtcStunPolicy = await readDesktopRuntimeHostWebRtcStunPolicy(input.clientDataRoot)
    .catch(() => ({ kind: 'disabled' }) as const);
  const webRtcStunUrls = resolveRuntimeHostWebRtcStunUrls(webRtcStunPolicy);
  if (explicitNativePath || explicitKeyPath) {
    return explicitNativePath && explicitKeyPath
      ? {
          nativePath: explicitNativePath,
          keyPath: explicitKeyPath,
          automaticRelayDiscovery: true,
          webRtcStunUrls,
          webRtcStunPolicy,
        }
      : undefined;
  }
  if (!input.isPackaged && !input.enableDevelopmentPeer) return undefined;
  const nativePath = input.isPackaged
    ? join(input.resourcesPath, 'runtime-host-peer', NATIVE_FILE)
    : join(
        input.appPath,
        '..',
        '..',
        'native',
        'runtime-host-peer',
        'target',
        'release',
        NATIVE_FILE,
      );
  try {
    await access(nativePath);
  } catch {
    return undefined;
  }
  environment.MAKA_RUNTIME_HOST_PEER_NATIVE_PATH = nativePath;
  const keyPath = join(input.clientDataRoot, 'runtime-host-client.peer.key');
  environment.MAKA_RUNTIME_HOST_PEER_KEY_PATH = keyPath;
  return {
    nativePath,
    keyPath,
    automaticRelayDiscovery: true,
    webRtcStunUrls,
    webRtcStunPolicy,
  };
}

export async function readDesktopRuntimeHostWebRtcStunPolicy(
  clientDataRoot: string,
): Promise<RuntimeHostWebRtcStunPolicy> {
  const path = join(clientDataRoot, CONNECTIVITY_POLICY_FILE);
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'default' };
    throw error;
  }
  if (Buffer.byteLength(text, 'utf8') > CONNECTIVITY_POLICY_MAX_BYTES) {
    throw new RangeError('Desktop peer connectivity policy exceeds its size limit');
  }
  const document: unknown = JSON.parse(text);
  if (
    document === null ||
    typeof document !== 'object' ||
    Array.isArray(document) ||
    Object.keys(document).length !== 2 ||
    !('schemaVersion' in document) ||
    document.schemaVersion !== 1 ||
    !('webRtcStunPolicy' in document)
  ) {
    throw new TypeError('Desktop peer connectivity policy is invalid');
  }
  return decodeRuntimeHostWebRtcStunPolicy(document.webRtcStunPolicy);
}

export async function writeDesktopRuntimeHostWebRtcStunPolicy(
  clientDataRoot: string,
  value: unknown,
): Promise<RuntimeHostWebRtcStunPolicy> {
  const webRtcStunPolicy = decodeRuntimeHostWebRtcStunPolicy(value);
  const path = join(clientDataRoot, CONNECTIVITY_POLICY_FILE);
  const temporaryPath = join(
    dirname(path),
    `.runtime-host-peer-connectivity-${randomUUID()}.tmp`,
  );
  const handle = await open(temporaryPath, 'wx', 0o600);
  try {
    try {
      await handle.writeFile(
        `${JSON.stringify({ schemaVersion: 1, webRtcStunPolicy }, null, 2)}\n`,
        'utf8',
      );
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporaryPath, path);
    await syncDirectory(dirname(path));
  } finally {
    await rm(temporaryPath, { force: true });
  }
  return webRtcStunPolicy;
}
