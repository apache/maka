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

import { requireCount, requireId, requireShapedRecord } from './codec.js';
import { decodeSessionAttention, type SessionAttention } from './session-attention.js';

export interface SessionCatalogChangedFrame {
  readonly kind: 'session.catalog.changed';
  readonly revision: number;
  readonly sessionId: string;
  readonly attention?: SessionAttention;
}

export function decodeSessionCatalogChangedFrame(value: unknown): SessionCatalogChangedFrame {
  const frame = requireShapedRecord(
    value,
    'Session catalog changed frame',
    ['kind', 'revision', 'sessionId'],
    ['attention'],
  );
  return {
    kind: 'session.catalog.changed',
    revision: requireCount(frame.revision, 'Session catalog change revision'),
    sessionId: requireId(frame.sessionId, 'sessionId'),
    ...(frame.attention === undefined
      ? {}
      : { attention: decodeSessionAttention(frame.attention) }),
  };
}
