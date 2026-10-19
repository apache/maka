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

import type { TurnOrigin } from '@maka/core/turn-origin';
import type { MessageContent } from '@maka/core/events';
import type { InboxInput } from './store.js';

export interface BotEndpoint {
  owner(): string | undefined;
  worker(): string | undefined;
  status(): unknown;
  hasUserMessage(id: string): boolean;
  receive(
    id: string,
    content: MessageContent,
    origin?: Extract<TurnOrigin, { kind: 'external_connector' }>,
  ): Promise<void>;
  post(input: InboxInput): void;
}
/** In-process routing only; durable mailbox and wake state belong to the Bot. */
export class AssistantBotBridge {
  private endpoint?: BotEndpoint;
  register(endpoint: BotEndpoint) {
    this.endpoint = endpoint;
  }
  status() {
    return this.endpoint?.status() ?? null;
  }
  isConversation(id: string) {
    return this.endpoint?.owner() === id;
  }
  hasUserMessage(sessionId: string, id: string) {
    return this.isConversation(sessionId) && this.endpoint!.hasUserMessage(id);
  }
  isWorker(id: string) {
    return this.endpoint?.worker() === id;
  }
  ownerFor(id: string) {
    return this.isWorker(id) ? this.endpoint?.owner() : undefined;
  }
  async receive(
    sessionId: string,
    id: string,
    content: MessageContent,
    origin?: Extract<TurnOrigin, { kind: 'external_connector' }>,
  ) {
    if (!this.isConversation(sessionId)) return false;
    await this.endpoint!.receive(id, content, origin);
    return true;
  }
  post(owner: string, input: InboxInput) {
    if (!this.isConversation(owner)) return false;
    this.endpoint!.post(input);
    return true;
  }
}
