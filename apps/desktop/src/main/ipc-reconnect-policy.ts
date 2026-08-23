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

import type { IpcMain } from "electron";
import type { Result } from "@maka/core/result";
import {
  RuntimeHostOperationError,
  RuntimeHostRequestInterruptedError,
} from "@maka/runtime-host/client";
import { HOST_OPERATION_SPECS } from "@maka/runtime-host/protocol";

export type IpcHandler = Parameters<IpcMain["handle"]>[1];

export interface ReconnectableReadIpcMain extends Pick<IpcMain, "handle"> {
  handleReconnectableRead?(channel: string, listener: IpcHandler): void;
}

export function handleReconnectableRead(
  ipcMain: ReconnectableReadIpcMain,
  channel: string,
  listener: IpcHandler,
): void {
  if (ipcMain.handleReconnectableRead) {
    ipcMain.handleReconnectableRead(channel, listener);
  } else {
    ipcMain.handle(channel, listener);
  }
}

export function isReconnectableReadFailure(error: unknown): boolean {
  return (
    (error instanceof RuntimeHostOperationError &&
      error.code === "host_draining" &&
      HOST_OPERATION_SPECS[error.operation].mode === "query") ||
    (error instanceof RuntimeHostRequestInterruptedError &&
      error.retryable &&
      error.reason === "connection_lost")
  );
}

export function rethrowReconnectableReadFailure(error: unknown): void {
  if (isReconnectableReadFailure(error)) throw error;
}

export async function readWithFallback<T>(
  read: () => Promise<T>,
  fallback: T,
): Promise<T> {
  try {
    return await read();
  } catch (error) {
    rethrowReconnectableReadFailure(error);
    return fallback;
  }
}

export async function tryReconnectableReadResult<T>(
  read: () => Promise<T>,
  errorCode: string,
): Promise<Result<T>> {
  try {
    return { ok: true, data: await read() };
  } catch (error) {
    rethrowReconnectableReadFailure(error);
    return {
      ok: false,
      error: {
        code: errorCode,
        message: error instanceof Error ? error.message : String(error),
        details: error,
      },
    };
  }
}
