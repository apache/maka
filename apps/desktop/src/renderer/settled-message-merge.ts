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

export function mergeSettledMessages(
  current: readonly StoredMessage[],
  incoming: readonly StoredMessage[],
): StoredMessage[] {
  const incomingById = new Map(incoming.map((message) => [message.id, message]));
  const knownIds = new Set(current.map((message) => message.id));
  return current
    .map((message) => incomingById.get(message.id) ?? message)
    .concat(incoming.filter((message) => !knownIds.has(message.id)));
}
