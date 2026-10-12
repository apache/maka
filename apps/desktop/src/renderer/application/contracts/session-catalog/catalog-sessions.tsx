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

// apps/desktop/src/renderer/application/contracts/session-catalog/catalog-sessions.tsx
//
// Render-prop subscription over the catalog's session list. It carries the
// useSyncExternalStore call so views inside debt-metered surfaces (settings,
// the shell) can render catalog rows without owning a hook call of their own.

import type { ReactNode } from 'react';
import type { DesktopSessionSummary } from '../../../../shared/desktop-session-projection.js';
import { selectSessions, type SessionCatalogController } from './session-catalog-state.js';
import { useExternalStoreSelector } from './use-external-store-selector.js';

export function CatalogSessions(props: {
  catalog: SessionCatalogController;
  children: (sessions: readonly DesktopSessionSummary[]) => ReactNode;
}): ReactNode {
  const sessions = useExternalStoreSelector(props.catalog, selectSessions);
  return props.children(sessions);
}
