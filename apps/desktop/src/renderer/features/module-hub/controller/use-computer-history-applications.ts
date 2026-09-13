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

import { useCallback, useEffect, useState } from 'react';
import type { ComputerHistoryApplication } from '@maka/core/computer-history';
import { useModuleHubServices } from '../services-context.js';

const BUNDLE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]*(?:\.[A-Za-z0-9][A-Za-z0-9-]*)+$/u;

export function useComputerHistoryApplications(bundleIds: readonly string[]) {
  const { computerHistory: service } = useModuleHubServices();
  // Historical sources can lack a bundle ID; keep those on the initial fallback.
  const key = JSON.stringify([...new Set(bundleIds.filter((id) =>
    id.length <= 256 && BUNDLE_ID_PATTERN.test(id),
  ))].sort());
  const [applications, setApplications] = useState<ReadonlyMap<string, ComputerHistoryApplication>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision((value) => value + 1), []);

  useEffect(() => {
    let cancelled = false;
    const ids = JSON.parse(key) as string[];
    setError(null);
    setApplications((previous) => new Map(ids.flatMap((id) => {
      const application = previous.get(id);
      return application ? [[id, application] as const] : [];
    })));
    // Main owns the metadata cache. Resolve one bounded batch at a time.
    void (async () => {
      for (let offset = 0; offset < ids.length; offset += 32) {
        try {
          const result = await service.applications(ids.slice(offset, offset + 32));
          if (cancelled) return;
          setApplications((previous) => new Map([
            ...previous,
            ...result.map((application) => [application.bundleIdentifier, application] as const),
          ]));
        } catch (failure) {
          if (cancelled) return;
          setError(failure instanceof Error ? failure.message : String(failure));
          return;
        }
      }
    })();
    return () => { cancelled = true; };
  }, [key, service, revision]);

  return { applications, error, refresh };
}
