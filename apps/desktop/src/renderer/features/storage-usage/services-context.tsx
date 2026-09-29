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

import { createContext, type ReactNode, useContext, useMemo } from 'react';
import { createSessionStorageLoader, type SessionStorageLoader } from './model/session-storage-loader.js';
import type { StorageUsageServices } from './ports.js';

interface StorageUsageContextValue {
  readonly services: StorageUsageServices;
  /** One per-task size cache for every list that shows task sizes. */
  readonly sessionLoader: SessionStorageLoader;
}

const StorageUsageServicesContext = createContext<StorageUsageContextValue | undefined>(undefined);

export function StorageUsageServicesProvider(props: {
  readonly services: StorageUsageServices;
  readonly children?: ReactNode;
}) {
  const value = useMemo<StorageUsageContextValue>(
    () => ({
      services: props.services,
      sessionLoader: createSessionStorageLoader((sessionIds) =>
        props.services.loadSessionUsage(sessionIds),
      ),
    }),
    [props.services],
  );
  return (
    <StorageUsageServicesContext.Provider value={value}>
      {props.children}
    </StorageUsageServicesContext.Provider>
  );
}

/** Undefined outside a Desktop composition; the surfaces then render nothing. */
export function useOptionalStorageUsageServices(): StorageUsageServices | undefined {
  return useContext(StorageUsageServicesContext)?.services;
}

export function useOptionalSessionStorageLoader(): SessionStorageLoader | undefined {
  return useContext(StorageUsageServicesContext)?.sessionLoader;
}
