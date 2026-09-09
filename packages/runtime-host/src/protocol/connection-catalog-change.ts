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

import { requireCount, requireExactRecord } from './codec.js';

/**
 * The Host resolves a connection's models differently than it did a moment
 * ago, without the stored catalog having changed. Re-read
 * `connection.catalog.query`; nothing else about the connection moved.
 *
 * Separate from `configuration.changed`, which says the user's runtime policy
 * was mutated. A client that shows a settings-changed-elsewhere notice must
 * not show it because the Host refreshed its model metadata.
 */
export interface ConnectionCatalogChangedFrame {
  readonly kind: 'connection.catalog.changed';
  readonly revision: number;
}

export function decodeConnectionCatalogChangedFrame(value: unknown): ConnectionCatalogChangedFrame {
  const frame = requireExactRecord(value, 'connection catalog changed frame', ['kind', 'revision']);
  return {
    kind: 'connection.catalog.changed',
    revision: requireCount(frame.revision, 'connection catalog change revision'),
  };
}
