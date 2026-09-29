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

import { createContext, type ReactNode, useContext, useEffect, useState } from 'react';
import { Text } from '@astryxdesign/core/Text';
import { useUiLocale } from '@maka/ui';
import type { SessionStorageUsage } from '@maka/runtime-host/protocol';
import { getStorageUsageCopy } from '../../../locales/storage-usage-copy.js';
import { formatStorageSize } from '../model/format-storage-size.js';
import {
  createSessionStorageLoader,
  sessionStorageBytes,
  type SessionStorageLoader,
} from '../model/session-storage-loader.js';
import { useOptionalStorageUsageServices } from '../services-context.js';

const SessionStorageLoaderContext = createContext<SessionStorageLoader | undefined>(undefined);

/**
 * Owns the per-task size cache for one list. Rows measure themselves as they
 * mount, and rows mounted together share one Host query, so only the rows on
 * screen are ever measured.
 */
export function TaskStorageSizeScope(props: { readonly children?: ReactNode }) {
  const services = useOptionalStorageUsageServices();
  const [loader] = useState(() =>
    services
      ? createSessionStorageLoader((sessionIds) => services.loadSessionUsage(sessionIds))
      : undefined,
  );
  return (
    <SessionStorageLoaderContext.Provider value={loader}>
      {props.children}
    </SessionStorageLoaderContext.Provider>
  );
}

/** A task's measured size, or nothing while unknown. Never a guess. */
export function TaskStorageSize(props: { readonly sessionId: string }) {
  const loader = useContext(SessionStorageLoaderContext);
  const locale = useUiLocale();
  const [usage, setUsage] = useState<SessionStorageUsage | undefined>(undefined);

  useEffect(() => {
    if (!loader) return;
    let current = true;
    setUsage(undefined);
    void loader.load(props.sessionId).then((measured) => {
      if (current) setUsage(measured);
    });
    return () => {
      current = false;
    };
  }, [loader, props.sessionId]);

  if (!usage) return null;
  return (
    <Text type="supporting" size="sm" color="secondary">
      {getStorageUsageCopy(locale).taskSize(
        formatStorageSize(sessionStorageBytes(usage), locale),
      )}
    </Text>
  );
}
