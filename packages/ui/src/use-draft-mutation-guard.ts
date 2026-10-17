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

import { useLayoutEffect, useMemo, useRef } from 'react';

export interface DraftMutationGuard {
  isCurrent(): boolean;
  release(): void;
}

/** Pending claims only: no permanent version table for every visited Session.
 * Mutations invalidate synchronously, including write-then-clear in one render.
 * Merely selecting another draft does not change its contents. */
export function useDraftMutationGuard() {
  const mounted = useRef(true);
  const guards = useMemo(() => {
    const claims = new Map<string | undefined, Set<symbol>>();
    return {
      hasPending: () => claims.size > 0,
      changed(key: string | undefined): void { claims.delete(key); },
      clear(): void { claims.clear(); },
      capture(key: string | undefined): DraftMutationGuard {
        if (!mounted.current) return { isCurrent: () => false, release() {} };
        const claim = Symbol();
        const bucket = claims.get(key) ?? new Set<symbol>();
        bucket.add(claim);
        claims.set(key, bucket);
        return {
          isCurrent: () => claims.get(key)?.has(claim) === true,
          release: () => {
            bucket.delete(claim);
            if (bucket.size === 0 && claims.get(key) === bucket) claims.delete(key);
          },
        };
      },
    };
  }, []);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; guards.clear(); };
  }, [guards]);
  return guards;
}
