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

import { constants } from 'node:fs';
import { access, realpath, stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  RuntimeHostServiceManagerError,
  type RuntimeHostManagedServiceConfig,
} from './runtime-host-service-manager.js';
import { resolveRuntimeHostPeerNativePath } from './runtime-host-peer-artifact.js';

export function runtimeHostServiceLaunchArguments(
  config: RuntimeHostManagedServiceConfig,
  serviceConfigPath: string,
): readonly string[] {
  return [
    config.launch.nodePath,
    config.launch.cliPath,
    'runtime-host',
    'serve',
    '--managed-service-config',
    serviceConfigPath,
    '--json',
  ];
}

/** Exact launch contract used before the managed configuration became authoritative. */
export function legacyRuntimeHostServiceLaunchArguments(
  config: RuntimeHostManagedServiceConfig,
): readonly string[] {
  return [
    config.launch.nodePath,
    config.launch.cliPath,
    'runtime-host',
    'serve',
    '--root',
    config.rootPath,
    ...config.projectDirectoryRoots.flatMap(({ label, path }) => [
      '--project-root',
      `${label}=${path}`,
    ]),
    '--websocket-host',
    config.websocket.host,
    '--websocket-port',
    String(config.websocket.port),
    '--websocket-path',
    config.websocket.path,
    '--json',
  ];
}

export const RUNTIME_HOST_UPDATE_INTERVAL_SECONDS = 24 * 60 * 60;
export const RUNTIME_HOST_UPDATE_INITIAL_DELAY_SECONDS = 15 * 60;
export const RUNTIME_HOST_UPDATE_RANDOM_DELAY_SECONDS = 60 * 60;

export function runtimeHostUpdateReconcileLaunchArguments(
  config: RuntimeHostManagedServiceConfig,
): readonly string[] | null {
  return config.managedDeploymentRoot
    ? [join(config.managedDeploymentRoot, 'operator'), 'reconcile-update', '--framed']
    : null;
}

export async function validateRuntimeHostServiceLaunch(
  config: RuntimeHostManagedServiceConfig,
): Promise<void> {
  try {
    const [nodePath, cliPath] = await Promise.all([
      realpath(config.launch.nodePath),
      realpath(config.launch.cliPath),
    ]);
    const peerNativePath = config.peer?.enabled
      ? await resolveRuntimeHostPeerNativePath(cliPath)
      : undefined;
    const [node, cli, peerNative] = await Promise.all([
      stat(nodePath),
      stat(cliPath),
      peerNativePath ? stat(peerNativePath) : undefined,
    ]);
    if (!node.isFile() || !cli.isFile() || (peerNative && !peerNative.isFile())) {
      throw new Error('Launch path is not a file');
    }
    await Promise.all([
      access(nodePath, constants.X_OK),
      access(cliPath, constants.R_OK),
      ...(peerNativePath ? [access(peerNativePath, constants.R_OK)] : []),
    ]);
  } catch (error) {
    throw new RuntimeHostServiceManagerError(
      'invalid_launch',
      'A configured Runtime Host launch file is unavailable',
      { cause: error },
    );
  }
}
