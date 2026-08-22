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

import type { ExternalSessionCatalogItem } from '@maka/runtime-host/protocol';
import {
  desktopSessionKey,
  type DesktopHostRef,
} from '../shared/runtime-host-identity.js';

/** Main-process projection before Host-local Session ids enter the preload boundary. */
export type DesktopHostExternalSessionCatalogItem = Omit<
  ExternalSessionCatalogItem,
  'hostCwd'
> & {
  /** Main maps the Host-only path name onto Desktop's existing cwd vocabulary. */
  readonly cwd: string;
};

/** Renderer import state whose Session ids are scoped Desktop Session keys. */
export type DesktopExternalSessionImportState = Omit<
  ExternalSessionCatalogItem['importState'],
  'importedSessionIds'
> & {
  /** Values produced by desktopSessionKey for the selected Runtime Host. */
  readonly importedSessionIds: readonly string[];
};

/** Renderer projection of a Host external Session catalog item. */
export type DesktopExternalSessionCatalogItem = Omit<
  DesktopHostExternalSessionCatalogItem,
  'importState'
> & {
  readonly importState: DesktopExternalSessionImportState;
};

export function projectDesktopExternalSessionCatalogItem(
  host: DesktopHostRef,
  item: DesktopHostExternalSessionCatalogItem,
): DesktopExternalSessionCatalogItem {
  return {
    ...item,
    importState: {
      ...item.importState,
      importedSessionIds: item.importState.importedSessionIds.map((sessionId) =>
        desktopSessionKey({ hostId: host.hostId, sessionId }),
      ),
    },
  };
}
