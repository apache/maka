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

import { createContext, type ReactNode, useContext } from 'react';
import type { ArchivedTaskCleanupServices } from './ports.js';

const ArchivedTaskCleanupServicesContext = createContext<ArchivedTaskCleanupServices | undefined>(
  undefined,
);

export function ArchivedTaskCleanupServicesProvider(props: {
  readonly services: ArchivedTaskCleanupServices;
  readonly children?: ReactNode;
}) {
  return (
    <ArchivedTaskCleanupServicesContext.Provider value={props.services}>
      {props.children}
    </ArchivedTaskCleanupServicesContext.Provider>
  );
}

/** Undefined outside a Desktop composition; a confirm then says it cannot preview. */
export function useOptionalArchivedTaskCleanupServices(): ArchivedTaskCleanupServices | undefined {
  return useContext(ArchivedTaskCleanupServicesContext);
}
