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

import { access } from 'node:fs/promises';
import { join } from 'node:path';

const NATIVE_FILE = 'maka_runtime_host_peer.node';

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
} | undefined> {
  const environment = input.environment ?? process.env;
  const explicitNativePath = environment.MAKA_RUNTIME_HOST_PEER_NATIVE_PATH?.trim();
  const explicitKeyPath = environment.MAKA_RUNTIME_HOST_PEER_KEY_PATH?.trim();
  if (explicitNativePath || explicitKeyPath) {
    return explicitNativePath && explicitKeyPath
      ? {
          nativePath: explicitNativePath,
          keyPath: explicitKeyPath,
          automaticRelayDiscovery: true,
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
  return { nativePath, keyPath, automaticRelayDiscovery: true };
}
