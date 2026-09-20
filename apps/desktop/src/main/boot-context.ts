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

import type { DesktopDiagnosticsDeps } from './main-process-diagnostics.js';
import type { RuntimeHostDesktopManager } from './runtime-host-desktop-manager.js';
import type { DesktopTargetScope } from '../shared/runtime-host-identity.js';

let resolveIpcReady!: () => void;
let rejectIpcReady!: (error: unknown) => void;
const ipcReady = new Promise<void>((resolve, reject) => {
  resolveIpcReady = resolve;
  rejectIpcReady = reject;
});

// Cross-module late bindings between the early window path and the Runtime
// Host boot: the window is created while the heavy module graph is still
// evaluating, so pieces the window needs early (diagnostics, quit hooks) read
// the Host-side products through this holder once they exist.
export const bootContext: {
  runtimeHostManager?: RuntimeHostDesktopManager;
  activeRuntimeHostRef?: () => DesktopTargetScope | undefined;
  resolveRuntimeHostDiagnostics?: DesktopDiagnosticsDeps['resolveRuntimeHost'];
  prepareToQuit?: () => Promise<'ready' | 'cancelled'>;
  cleanup?: () => Promise<void>;
  /**
   * Settles once the Runtime Host boot module's registration pass has run.
   * The preload gates renderer invokes on this so a call made before the
   * handlers exist waits instead of hitting "No handler registered".
   */
  ipcReady: Promise<void>;
  markIpcReady(): void;
  failIpcReady(error: unknown): void;
} = {
  ipcReady,
  markIpcReady: () => resolveIpcReady(),
  failIpcReady: (error: unknown) => rejectIpcReady(error),
};
