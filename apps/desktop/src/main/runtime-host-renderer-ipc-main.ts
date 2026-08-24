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

import {
  HOST_OPERATION_SPECS,
  isOperationKey,
} from '@maka/runtime-host/protocol';
import {
  RENDERER_RUNTIME_HOST_OPERATIONS,
  type RendererRuntimeHostOperation,
} from '../preload/runtime-host-renderer-operations.js';
import {
  handleReconnectableRead,
  type ReconnectableReadIpcMain,
} from './ipc-reconnect-policy.js';
import type { DesktopRuntimeHostClient } from './runtime-host-client.js';

/**
 * The only generic Electron pass-through for renderer-visible Runtime Host
 * protocol operations. Desktop adapters remain separate when they add native
 * OS behavior, credential authority, event streams, or composed projections.
 *
 * Runtime Host protocol codecs remain the canonical input/output boundary. The
 * explicit allowlist prevents the renderer from acquiring lifecycle, credential
 * export, or Client Capability authority merely because those operations exist.
 */
export function registerRuntimeHostRendererIpc(input: {
  readonly ipcMain: ReconnectableReadIpcMain;
  readonly client: DesktopRuntimeHostClient;
}): void {
  handleReconnectableRead(
    input.ipcMain,
    'runtime-host:query',
    (_event, operation: unknown, value: unknown) => {
      const key = admittedOperation(operation, 'query');
      return request(input.client, key, value);
    },
  );
  input.ipcMain.handle(
    'runtime-host:command',
    (_event, operation: unknown, value: unknown) => {
      const key = admittedOperation(operation, 'command');
      return request(input.client, key, value);
    },
  );
}

function admittedOperation(
  value: unknown,
  transport: 'query' | 'command',
): RendererRuntimeHostOperation {
  if (
    !isOperationKey(value) ||
    !isRendererRuntimeHostOperation(value)
  ) {
    throw new Error('Runtime Host operation is not available to the Desktop renderer');
  }
  const mode = HOST_OPERATION_SPECS[value].mode;
  if ((transport === 'query') !== (mode === 'query')) {
    throw new Error(`Runtime Host ${value} must use its declared operation mode`);
  }
  return value;
}

function isRendererRuntimeHostOperation(value: string): value is RendererRuntimeHostOperation {
  return RENDERER_RUNTIME_HOST_OPERATIONS.some((operation) => operation === value);
}

function request(
  client: DesktopRuntimeHostClient,
  operation: RendererRuntimeHostOperation,
  value: unknown,
): Promise<unknown> {
  switch (operation) {
    case 'context.diagnostics.query':
      return client.request(operation, HOST_OPERATION_SPECS[operation].decodeInput(value));
    case 'daily-review.mutate':
      return client.request(operation, HOST_OPERATION_SPECS[operation].decodeInput(value));
    case 'daily-review.query':
      return client.request(operation, HOST_OPERATION_SPECS[operation].decodeInput(value));
    case 'execution.inspect.query':
      return client.request(operation, HOST_OPERATION_SPECS[operation].decodeInput(value));
    case 'scheduled-task.mutate':
      return client.request(operation, HOST_OPERATION_SPECS[operation].decodeInput(value));
    case 'scheduled-task.query':
      return client.request(operation, HOST_OPERATION_SPECS[operation].decodeInput(value));
    case 'web-search.execute':
      return client.request(operation, HOST_OPERATION_SPECS[operation].decodeInput(value));
  }
}
