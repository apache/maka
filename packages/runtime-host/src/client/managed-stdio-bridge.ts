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

import { connect, type Socket } from 'node:net';
import { resolveExistingStorageRootControlDirectory } from '@maka/storage/root-authority';
import { readHostRegistration } from '../control/registration.js';
import { resolveRuntimeHostManagedDeployment } from '../operator/managed-deployment.js';
import {
  activateRuntimeHostManagedDeployment,
  type ActivateRuntimeHostManagedDeploymentInput,
} from './managed-activation.js';

const BRIDGE_CONNECT_TIMEOUT_MS = 5_000;

export async function openRuntimeHostManagedStdioBridge(
  input: ActivateRuntimeHostManagedDeploymentInput,
  overrides: {
    readonly activate?: (
      input: ActivateRuntimeHostManagedDeploymentInput,
    ) => ReturnType<typeof activateRuntimeHostManagedDeployment>;
    readonly openSocket?: (endpoint: string) => Promise<Socket>;
  } = {},
): Promise<Socket> {
  const activation = await (overrides.activate ?? activateRuntimeHostManagedDeployment)(input);
  const resolved = await resolveRuntimeHostManagedDeployment(input.rootId, input.authority);
  const { controlDirectory } = await resolveExistingStorageRootControlDirectory(
    resolved.capability,
  );
  const registration = await readHostRegistration(controlDirectory);
  if (
    !registration ||
    registration.rootId !== activation.rootId ||
    registration.hostEpoch !== activation.hostEpoch
  ) {
    throw new Error('The activated Runtime Host registration changed before bridge connection');
  }
  return (overrides.openSocket ?? openBridgeSocket)(registration.endpoint);
}

function openBridgeSocket(endpoint: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect(endpoint);
    const timer = setTimeout(() => {
      cleanup();
      socket.destroy();
      reject(new Error('Timed out connecting the Runtime Host stdio bridge'));
    }, BRIDGE_CONNECT_TIMEOUT_MS);
    const cleanup = () => {
      clearTimeout(timer);
      socket.off('connect', onConnect);
      socket.off('error', onError);
    };
    const onConnect = () => {
      cleanup();
      resolve(socket);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    socket.once('connect', onConnect);
    socket.once('error', onError);
  });
}
