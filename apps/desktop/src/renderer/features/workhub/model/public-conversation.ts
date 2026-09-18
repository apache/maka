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
import type { LiveTurnProjection } from '@maka/ui';

/** Hide internal tool records and active voice-coordination streams. */
export function workHubPublicConversation(messages: readonly StoredMessage[], liveTurn?: LiveTurnProjection) {
  const visibleMessages = messages.filter(message => message.presentation !== 'internal');
  if (!liveTurn) return { messages: visibleMessages, liveTurn };
  const inputs = messages.filter(message => message.type === 'user' && message.turnId === liveTurn.turnId);
  const steering = [...(liveTurn.pendingSteering ?? []), ...liveTurn.steps.flatMap(step => step.leadingSteering ?? [])];
  const isVoiceSource = (source: string | undefined) => source === 'voice_request' || source === 'voice_maintenance';
  const internal = inputs.some(message => message.type === 'user' && isVoiceSource(message.workhubSource)) || steering.some(message => isVoiceSource(message.content.workhubSource));
  // Until the input's structured source arrives, expose no raw stream.
  if (!inputs.length || internal) return { messages: visibleMessages, liveTurn: undefined };
  return { messages: visibleMessages, liveTurn };
}
