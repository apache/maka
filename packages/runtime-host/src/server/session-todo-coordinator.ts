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

import type { SessionTodoSnapshot } from '@maka/core/session-todo';
import {
  authenticateInteractiveSessionTodoWriter,
  type InteractiveSessionTodoWriter,
} from '@maka/storage/session-todo-authority';
import type { OperationOutcome, SessionTodoQueryResult } from '../protocol/index.js';
import type { SessionTodoOperationHandlerMap } from './operation-dispatcher.js';
import { SessionAdmissionGate } from './session-admission-gate.js';
import type { SessionPresenceReader } from './session-presence.js';

export interface SessionTodoPort {
  read(sessionId: string): Promise<SessionTodoSnapshot>;
  replace(sessionId: string, items: unknown): Promise<SessionTodoSnapshot>;
}

/** Host-owned admission and publication boundary for the SessionTodo document. */
export class HostSessionTodoCoordinator implements SessionTodoPort {
  readonly handlers: SessionTodoOperationHandlerMap = {
    'session.todo.query': (input) => this.#query(input.sessionId),
  };

  readonly #writer: InteractiveSessionTodoWriter;

  constructor(
    writer: InteractiveSessionTodoWriter,
    private readonly sessionAdmission: SessionAdmissionGate,
    private readonly sessions: SessionPresenceReader,
    private readonly onChanged: (sessionId: string) => void,
    private readonly requestDrain: () => void,
  ) {
    this.#writer = authenticateInteractiveSessionTodoWriter(writer);
  }

  read(sessionId: string): Promise<SessionTodoSnapshot> {
    return this.sessionAdmission.run(sessionId, async () => {
      await this.#requirePresent(sessionId);
      return this.#writer.readOrBootstrap(sessionId);
    });
  }

  replace(sessionId: string, items: unknown): Promise<SessionTodoSnapshot> {
    return this.sessionAdmission.run(sessionId, async () => {
      await this.#requirePresent(sessionId);
      const snapshot = await this.#writer.replaceAll(sessionId, items);
      try {
        this.onChanged(sessionId);
      } catch {
        // The document is already committed. A projection failure drains the
        // Host but must never turn a successful whole-document write into an
        // ambiguous retry that could overwrite a later writer.
        this.requestDrain();
      }
      return snapshot;
    });
  }

  async #query(sessionId: string): Promise<OperationOutcome<'session.todo.query'>> {
    try {
      const snapshot = await this.read(sessionId);
      const result: SessionTodoQueryResult = { sessionId, items: snapshot.items };
      return { ok: true, result };
    } catch (error) {
      if ((await this.sessions.probeSessionRemoval(sessionId)).kind !== 'present') {
        return { ok: false, error: { code: 'not_found', message: 'Session was not found' } };
      }
      throw error;
    }
  }

  async #requirePresent(sessionId: string): Promise<void> {
    if ((await this.sessions.probeSessionRemoval(sessionId)).kind !== 'present') {
      throw new Error(`Session was not found: ${sessionId}`);
    }
  }
}
