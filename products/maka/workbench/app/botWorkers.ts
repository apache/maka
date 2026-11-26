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

import type { Host } from './host';
import { createScopedCatalog } from './scopedCatalog';

/**
 * The conversations a Bot created, kept current by the Host's catalog stream. The stream
 * pushes when a worker is created, starts or ends a Turn, waits for the user, is renamed
 * or archived, so nothing is polled. Reads only while `enabled`.
 */
export function createBotWorkers(
  host: Pick<Host, 'query' | 'subscribe'>,
  bot: () => string | null,
  enabled: () => boolean,
) {
  const sessions = createScopedCatalog(host, () => {
    const id = bot();
    return id && enabled() ? { kind: 'children', sessionId: id } : null;
  });
  return { sessions };
}
