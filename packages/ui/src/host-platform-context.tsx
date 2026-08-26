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

import { createContext, useContext, type ReactNode } from 'react';
import type { ShortcutPlatform } from './keyboard-shortcut-display.js';

const HostPlatformContext = createContext<ShortcutPlatform | undefined>(undefined);

/**
 * Publishes the host OS to everything that has to spell something the way this
 * platform spells it — today the keyboard-shortcut labels (#3876).
 *
 * A context rather than a prop: the rail's new-task hint sits four components
 * below the shell that knows the answer, and none of the components in between
 * have anything to do with the host OS.
 */
export function HostPlatformProvider(props: {
  /** As `process.platform` spells it: `darwin`, `win32`, `linux`. */
  platform?: ShortcutPlatform;
  children: ReactNode;
}) {
  return (
    <HostPlatformContext.Provider value={props.platform}>
      {props.children}
    </HostPlatformContext.Provider>
  );
}

/**
 * The host OS, or undefined before the main process has answered — and in
 * Storybook, which has no main process at all. Undefined is a legitimate
 * value, not an error: every consumer resolves it from `navigator` (see
 * `usesAppleShortcutGlyphs`), so nothing has to wait for IPC to render.
 */
export function useHostPlatform(): ShortcutPlatform | undefined {
  return useContext(HostPlatformContext);
}
