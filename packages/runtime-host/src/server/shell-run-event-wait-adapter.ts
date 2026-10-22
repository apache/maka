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

import { createHash } from 'node:crypto';
import { isTerminalShellRunStatus } from '@maka/core/shell-run';
import type { ObservedEventWaitRecord } from '@maka/core/event-wait';
import type { ShellRunProcessManager } from '@maka/runtime/shell-run-manager';
import type {
  EventWaitSourceAdapter,
  EventWaitReadContext,
  EventWaitObservationResult,
} from './event-wait-adapter.js';
import {
  ShellRunEventWaitAccess,
  SHELL_RUN_WAIT_SOURCE,
  validateShellRunWait,
} from './shell-run-event-wait-access.js';

export class ShellRunEventWaitAdapter implements EventWaitSourceAdapter {
  readonly providerId = SHELL_RUN_WAIT_SOURCE.providerId;
  readonly resourceType = SHELL_RUN_WAIT_SOURCE.resourceType;
  readonly conditionType = SHELL_RUN_WAIT_SOURCE.conditionType;
  readonly conditionVersion = SHELL_RUN_WAIT_SOURCE.conditionVersion;
  readonly reconciliation = 'snapshot' as const;
  constructor(
    private readonly access: ShellRunEventWaitAccess,
    private readonly manager: Pick<ShellRunProcessManager, 'subscribeChanges'>,
  ) {}
  validate(wait: ObservedEventWaitRecord): void {
    validateShellRunWait(wait);
  }
  async read(input: EventWaitReadContext): Promise<EventWaitObservationResult> {
    const result = await this.access.read(input.wait, input.signal);
    // The next access check cancels and pauses on confirmed revocation. A read
    // racing that check must not fabricate a terminal outcome in the meantime.
    if (result.kind === 'revoked') return { kind: 'unknown', reason: result.reason };
    const fact = result.fact;
    if (!isTerminalShellRunStatus(fact.status)) return { kind: 'pending' };
    const digest = createHash('sha256').update(JSON.stringify(fact)).digest('hex');
    const receiptKey = `shell-run/terminal-v1/${fact.shellRunId}/${digest}`;
    return {
      kind: fact.status === 'orphaned' ? 'source_unavailable' : 'satisfied',
      receiptKey,
      eventKey: receiptKey,
      evidenceRefs: [input.wait.resource.resourceId],
    };
  }
  async subscribe(input: EventWaitReadContext, changed: () => void) {
    this.validate(input.wait);
    return this.manager.subscribeChanges(
      input.wait.sessionId,
      input.wait.resource.resourceId,
      input.signal,
      changed,
    );
  }
}
