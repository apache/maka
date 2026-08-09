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

export interface BotSessionCreateInput {
export interface BotSessionResolveInput {
  readonly conversationId: string;
  readonly name: string;
  readonly labels: readonly string[];
}

export type BotSessionResolution =
  | { readonly kind: 'ready'; readonly sessionId: string }
  | { readonly kind: 'permission_refused' };

export type BotSessionTurnResult =
  | { readonly kind: 'completed'; readonly text: string }
  | { readonly kind: 'suspended' }
  | { readonly kind: 'errored'; readonly reason: string };

export interface BotSessionAdapter {
  resolveSession(input: BotSessionResolveInput): Promise<BotSessionResolution>;
  releaseConversation(input: {
    readonly conversationId: string;
    readonly operationId: string;
  }): Promise<boolean>;
  runTurn(input: {
    readonly sessionId: string;
    readonly messageId: string;
    readonly text: string;
    /**
     * Best-effort projection of the latest assistant text for this Turn.
     *
     * Snapshots may replace previously observed text, so consumers must not
     * treat them as append-only deltas. The callback is synchronous by design:
     * a slow delivery channel must enqueue its own work instead of applying
     * backpressure to the Runtime Host subscription.
     */
    readonly onReplySnapshot?: (text: string) => void;
  }): Promise<BotSessionTurnResult>;
}
