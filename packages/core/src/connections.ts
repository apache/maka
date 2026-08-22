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
 * Connection-setup events & commands.
 *
 * These are NOT SessionEvents. Credential entry, OAuth handshake, and
 * connection-test results have no `turnId` and are not tied to a session.
 * They travel on the desktop bridge's `connections.*` channel, separate
 * from `sessions.*`.
 */

import type { LlmConnection } from './llm-connections.js';

interface BaseConnectionEvent {
  id: string;
  ts: number;
}

export type ConnectionEvent =
  | ConnectionCredentialRequestEvent
  | ConnectionTestResultEvent
  | ConnectionListChangedEvent;

export interface ConnectionCredentialRequestEvent extends BaseConnectionEvent {
  type: 'connection_credential_request';
  requestId: string;
  /** Target connection slug. */
  slug: string;
  scheme: 'bearer' | 'basic' | 'header' | 'query' | 'oauth';
  fields: Array<{ name: string; secret: boolean; description?: string }>;
}

export interface ConnectionTestResultEvent extends BaseConnectionEvent {
  type: 'connection_test_result';
  slug: string;
  success: boolean;
  error?: string;
  modelCount?: number;
}

/** Generic invalidation signal — UI re-fetches connection list. */
export interface ConnectionListChangedEvent extends BaseConnectionEvent {
  type: 'connection_list_changed';
}

export type ConnectionCommand =
  | {
      type: 'credential_response';
      requestId: string;
      values: Record<string, string>;
    }
  | { type: 'oauth_start'; slug: string }
  | { type: 'test'; slug: string }
  | { type: 'save'; slug: string; config: LlmConnection }
  | { type: 'delete'; slug: string };
