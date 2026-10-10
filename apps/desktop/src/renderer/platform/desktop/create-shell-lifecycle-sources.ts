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
import type { MakaBridge } from '../../../preload/bridge-contract.js';
import type { ShellLifecycleSources } from '../../application/contracts/shell-lifecycle.js';

export type DesktopShellLifecycleBridge = Pick<MakaBridge, 'app' | 'appWindow' | 'connections' | 'runtimeHostProfiles' | 'settings'>;

/** The root lifecycle's Desktop events, and the platform tag on the document. */
export function createDesktopShellLifecycleSources(
  bridge: DesktopShellLifecycleBridge = window.maka,
  root: Pick<HTMLElement, 'setAttribute'> = document.documentElement,
): ShellLifecycleSources {
  return {
    // Glass-material CSS (sidebar vibrancy passthrough) lights up only on
    // macOS, where `BrowserWindow({ vibrancy: 'sidebar' })` paints the native
    // blur behind the renderer; other platforms keep their opaque chrome.
    tagDocumentPlatform() {
      let cancelled = false;
      void bridge.app
        .info()
        .then((info) => {
          if (!cancelled) root.setAttribute('data-os', info.platform);
        })
        .catch(() => {
          /* swallow — leaves data-os unset, CSS falls back to opaque chrome */
        });
      return () => {
        cancelled = true;
      };
    },
    subscribeWindowCommands: (handler) => bridge.appWindow.subscribeCommand(handler),
    subscribeConnectionEvents: (handler) => bridge.connections.subscribeEvents(handler),
    subscribeRuntimeHostChanges: (handler) => bridge.runtimeHostProfiles.subscribeChanges(handler),
    subscribeClientSettingsChanges: (handler) => bridge.settings.subscribeClientChanged(handler),
    subscribeExternalSettingsChanges: (handler) => bridge.settings.subscribeExternalChanged(handler),
  };
}
