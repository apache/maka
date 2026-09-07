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
import type { AppUpdateStatus } from '../ports.js';

export interface AppUpdateAboutProjection {
  readonly status: AppUpdateStatus | null;
  readonly checking: boolean;
  readonly checkForUpdates: () => Promise<AppUpdateStatus>;
}

const AppUpdateAboutProjectionContext = createContext<AppUpdateAboutProjection | null>(null);

export const AppUpdateAboutProjectionProvider = AppUpdateAboutProjectionContext.Provider;

/** Reads the About projection; a mount outside `AppUpdateProvider` is a bug, not a quiet idle. */
export function AppUpdateAboutProjectionConsumer(props: {
  readonly children: (projection: AppUpdateAboutProjection) => ReactNode;
}): ReactNode {
  const projection = useContext(AppUpdateAboutProjectionContext);
  if (!projection) throw new Error('AppUpdateProvider is missing');
  return props.children(projection);
}
