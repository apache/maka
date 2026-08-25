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

import type { StoredMessage } from '@maka/core/session';

/**
 * Merge a renderer-only message into the current transcript until the
 * canonical transcript carries the same message id. The map is presentation
 * state only; it never decides delivery or retry.
 */
export function reconcileTransientMessages(
  transient: Map<string, StoredMessage>,
  durable: readonly StoredMessage[],
  options: { includeTransient?: boolean } = {},
): StoredMessage[] {
  for (const message of durable) transient.delete(message.id);
  if (transient.size === 0 || options.includeTransient === false) return [...durable];
  return [
    ...durable,
    ...[...transient.values()].sort((left, right) => left.ts - right.ts),
  ];
}
