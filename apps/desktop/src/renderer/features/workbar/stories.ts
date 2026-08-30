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

/**
 * Storybook-only entry, separate from `testing` for a reason the module graph
 * enforces: `testing` is loaded by `node --test` against tsc output, and
 * `workbar-surface` and its tool panels use extensionless relative specifiers
 * that only a bundler resolves. Stories run through Vite, so they can reach
 * the surface; the node suites cannot, and must not be made to.
 *
 * The production entry omits `WorkbarSurface` on top of that: `workbar-host`
 * reaches it through `lazy()`, and a static re-export beside `WorkbarHost`
 * would pull the surface and its five tool panels back into the eager chunk.
 * Nothing shipped imports this module either.
 */

export { WorkbarSurface } from './ui/workbar-surface.js';
