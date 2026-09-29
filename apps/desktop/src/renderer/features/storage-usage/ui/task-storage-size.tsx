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

import { useEffect, useState } from 'react';
import { Text } from '@astryxdesign/core/Text';
import { formatBytes, useUiLocale } from '@maka/ui';
import type { SessionStorageUsage } from '@maka/runtime-host/protocol';
import { getStorageUsageCopy } from '../../../locales/storage-usage-copy.js';
import { sessionStorageBytes } from '../model/session-storage-loader.js';
import { useOptionalSessionStorageLoader } from '../services-context.js';

/**
 * A task's measured size, or nothing while unknown. Never a guess.
 *
 * Each mounted row asks for its own size. The archived-task list is not
 * virtualized, so every row that passes the search mounts; the shared loader
 * measures them sequentially, one bounded Host request at a time.
 */
export function TaskStorageSize(props: { readonly sessionId: string }) {
  const loader = useOptionalSessionStorageLoader();
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
      {getStorageUsageCopy(locale).taskSize(formatBytes(sessionStorageBytes(usage), locale))}
    </Text>
  );
}
