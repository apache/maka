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
import type { SessionBundleServices } from '../../features/session-bundle';

export type DesktopSessionBundleBridge = Pick<MakaBridge, 'sessionBundles'>;

/** Binds the Session bundle feature to the Desktop bridge. */
export function createDesktopSessionBundleServices(
  bridge: DesktopSessionBundleBridge = window.maka,
): SessionBundleServices {
  return {
    // No host argument: a Session belongs to the Host that holds it, not to
    // whichever one Settings happens to be pointed at, and the bridge routes by
    // the projected id for exactly that reason.
    exportBundle: (input) => bridge.sessionBundles.export(input),
    importBundle: async () => {
      const result = await bridge.sessionBundles.import();
      return result.ok ? { ok: true, sessionCount: result.sessionCount } : result;
    },
  };
}
