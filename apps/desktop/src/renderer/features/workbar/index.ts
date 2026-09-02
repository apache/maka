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

// `WorkbarSurface` is deliberately absent: `workbar-host` reaches it through
// `lazy(() => import('./workbar-surface'))`, and re-exporting it here would
// pull the surface and its five nested tool panels back into the eager chunk
// for every importer of this barrel. Stories reach it through `stories`,
// which nothing shipped imports.
export { WorkbarHost } from './ui/workbar-host';
export { WorkbarTitlebarActions } from './ui/workbar-toggle';
export { WorkbarServicesProvider } from './services-context';
export { useWorkbarController } from './controller/use-workbar-controller';
export type { SessionWorkbarTabKind } from './model/workbar-tabs';
export type { WorkbarServices } from './ports';
