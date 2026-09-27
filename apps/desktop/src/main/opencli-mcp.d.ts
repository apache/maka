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

// opencli-mcp publishes no type declarations.

declare module 'opencli-mcp/dist/src/host/extension.js' {
  export const EXTENSION_ID: string;
  export const EXTENSION_STORE_URL: string;
}

declare module 'opencli-mcp/dist/src/host/registration.js' {
  export function nativeHostDirs(): Array<{ browser: string; dir: string }>;
  export function runningProfileDirs(): string[];
}

declare module 'opencli-mcp/dist/src/host/state.js' {
  export interface HostState {
    pid: number;
    port: number;
    host: string;
    token: string;
  }
  export function readHostState(): HostState | null;
  export function hostHealth(state: HostState | null, timeoutMs?: number): Promise<{ ok: boolean; extensionConnected?: boolean; error?: string }>;
}

declare module 'opencli-mcp/dist/src/protocol.js' {
  export const NATIVE_HOST_NAME: string;
}
