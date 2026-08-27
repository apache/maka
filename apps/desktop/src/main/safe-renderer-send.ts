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

interface RendererSendTarget {
  isDestroyed(): boolean;
  readonly webContents: {
    isDestroyed(): boolean;
    send(channel: string, ...args: unknown[]): void;
  };
}

/**
 * Creates a main-to-renderer sender that tolerates Electron teardown races.
 * The target is resolved for each send because the app can close and recreate
 * its main window while the process remains alive.
 */
export function createSafeRendererSender(
  resolveTarget: () => RendererSendTarget | null,
): (channel: string, ...args: unknown[]) => void {
  return (channel, ...args) => {
    const target = resolveTarget();
    if (!target || target.isDestroyed()) return;
    const webContents = target.webContents;
    if (webContents.isDestroyed()) return;
    webContents.send(channel, ...args);
  };
}
