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

import type { InlineReference } from '@maka/core/events';

/** IDs are desktopSessionKey values, including group members. */
export interface SessionWindowGroup {
  readonly hostId: string;
  readonly groupId: string;
  readonly sessionIds: readonly string[];
}
export interface SessionWindowNavigation {
  readonly sessionId: string;
  readonly turnId?: string;
  readonly sequence?: number;
}
export type SessionWindowContext =
  | { readonly kind: 'main'; readonly windowId: string }
  | { readonly kind: 'session'; readonly windowId: string; readonly group: SessionWindowGroup; readonly initialSessionId: string };

/** A read-only projection for synchronous navigation; Main still authorizes IPC. */
export interface SessionWindowOwnership {
  readonly version: number;
  readonly sessionIds: readonly string[];
}
export interface SessionWindowDraft {
  readonly sessionId: string;
  readonly text: string;
  readonly references: readonly InlineReference[];
}
export type SessionWindowCommand =
  | { readonly requestId: string; readonly kind: 'prepare'; readonly transferId: string; readonly group: SessionWindowGroup }
  | { readonly requestId: string; readonly kind: 'receive'; readonly transferId: string; readonly group: SessionWindowGroup; readonly navigation: SessionWindowNavigation; readonly drafts: readonly SessionWindowDraft[] }
  | { readonly requestId: string; readonly kind: 'abort'; readonly transferId: string }
  | { readonly requestId: string; readonly kind: 'navigate'; readonly navigation: SessionWindowNavigation }
  | { readonly requestId: string; readonly kind: 'check-close'; readonly group: SessionWindowGroup }
  | { readonly requestId: string; readonly kind: 'cancel-close' };
export interface SessionWindowCommandResult {
  readonly drafts?: readonly SessionWindowDraft[];
  readonly activeSessionId?: string;
  readonly hasUnsent?: boolean;
}
export type SessionWindowCommandReply =
  | { readonly requestId: string; readonly ok: true; readonly result?: SessionWindowCommandResult }
  | { readonly requestId: string; readonly ok: false; readonly error: string };
export interface SessionWindowBridge {
  context(): Promise<SessionWindowContext>;
  ownership(): Promise<SessionWindowOwnership>;
  subscribeSessionWindowOwnership(handler: (ownership: SessionWindowOwnership) => void): () => void;
  routeSession(navigation: SessionWindowNavigation): Promise<void>;
  openSessionWindow(sessionId: string): Promise<void>;
  openInMainWindow(): Promise<void>;
  /** Installed command handlers are ready, independently of first paint. */
  sessionWindowReady(): Promise<void>;
  subscribeSessionWindowCommand(handler: (command: SessionWindowCommand) => void): () => void;
  ackSessionWindowCommand(reply: SessionWindowCommandReply): Promise<void>;
  commandMain(command: 'newTask' | 'openSettings' | 'openHelp'): Promise<void>;
}
