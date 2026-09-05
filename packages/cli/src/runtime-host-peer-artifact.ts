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

import { access, realpath } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

const PEER_NATIVE_FILE = 'maka_runtime_host_peer.node';
const SUPPORTED_TARGETS = new Set(['darwin-arm64', 'linux-arm64', 'linux-x64', 'win32-x64']);

export async function resolveRuntimeHostNativePath(cliPath: string): Promise<string> {
  const packageRoot = dirname(dirname(await realpath(cliPath)));
  const target = runtimeHostPeerTarget();
  const packaged = join(
    packageRoot,
    'native',
    'runtime-host-peer',
    'prebuilds',
    target,
    PEER_NATIVE_FILE,
  );
  if (await isReadable(packaged)) return realpath(packaged);

  if (basename(packageRoot) === 'cli' && basename(dirname(packageRoot)) === 'packages') {
    const development = join(
      packageRoot,
      '..',
      '..',
      'native',
      'runtime-host-peer',
      'target',
      'release',
      PEER_NATIVE_FILE,
    );
    if (await isReadable(development)) return realpath(development);
  }

  throw new Error(`Maka does not include a Runtime Host native artifact for ${target}`);
}

export function runtimeHostPeerTarget(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string {
  const target = `${platform}-${arch}`;
  if (!SUPPORTED_TARGETS.has(target)) {
    throw new Error(`Direct peer is not available on ${target}`);
  }
  return target;
}

export function resolveRuntimeHostManagedPeerKeyPath(clientDataRoot: string): string {
  return join(clientDataRoot, 'runtime-host-service.peer.key');
}

export function resolveRuntimeHostClientPeerKeyPath(clientDataRoot: string): string {
  return join(clientDataRoot, 'runtime-host-client.peer.key');
}

export function hasEphemeralRuntimeHostPeerPort(address: string): boolean {
  return /\/(?:tcp|udp)\/0(?:\/|$)/u.test(address);
}

export async function configureRuntimeHostPeerClient(input: {
  readonly cliPath: string;
  readonly clientDataRoot: string;
  readonly environment?: NodeJS.ProcessEnv;
}): Promise<boolean> {
  const environment = input.environment ?? process.env;
  const explicitNativePath = environment.MAKA_RUNTIME_HOST_PEER_NATIVE_PATH?.trim();
  const explicitKeyPath = environment.MAKA_RUNTIME_HOST_PEER_KEY_PATH?.trim();
  if (explicitNativePath || explicitKeyPath) return Boolean(explicitNativePath && explicitKeyPath);
  try {
    environment.MAKA_RUNTIME_HOST_PEER_NATIVE_PATH = await resolveRuntimeHostNativePath(
      input.cliPath,
    );
    environment.MAKA_RUNTIME_HOST_PEER_KEY_PATH = resolveRuntimeHostClientPeerKeyPath(
      input.clientDataRoot,
    );
    return true;
  } catch {
    return false;
  }
}

async function isReadable(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
