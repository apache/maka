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

import type { BackendStopMode, SteeringLease } from '@maka/core/backend-types';
import type { RootExecutionDescriptor } from '@maka/core/agent-run';
import type { MessageContent, SessionEvent } from '@maka/core/events';

export interface RuntimeMessageRunIdentity {
  readonly sessionId: string;
  readonly turnId: string;
  readonly runId: string;
}

/** Synchronous lease bridge owned by the Runtime Host for one live root run. */
export interface RuntimeMessageRunOwner extends RuntimeMessageRunIdentity {
  pull(): readonly SteeringLease[];
  ack(leaseIds: readonly string[]): void;
  nack(leaseIds: readonly string[]): void;
  /** Ends Runtime access; the Host closes admission at its terminal transition cut. */
  release(): void;
}

/** Process-wide factory. Queue admission and projection remain Host responsibilities. */
export interface RuntimeMessageAuthority {
  bindRun(identity: RuntimeMessageRunIdentity): RuntimeMessageRunOwner;
}

export interface RuntimeHostedRootExecutionInput extends RuntimeMessageRunIdentity {
  readonly userMessageId: string | null;
  readonly execution: RootExecutionDescriptor;
  readonly content: MessageContent;
  /**
   * First-admission control-plane gate. Existing durable admissions bypass it
   * so recovery never depends on mutable scheduling state.
   */
  readonly admitExecution?: () => Promise<'executing' | 'cancelled'>;
  readonly start: (input: {
    readonly runId: string;
    readonly userMessageId: string | null;
    readonly onRunStarted: () => void | Promise<void>;
  }) => AsyncIterable<SessionEvent>;
  readonly onEvent?: (event: SessionEvent) => void;
  readonly onReady?: () => void | Promise<void>;
}

/** Host-only root lifecycle capability. Embedded compositions must omit it. */
export interface RuntimeHostedRootAuthority extends RuntimeMessageAuthority {
  executeRoot(input: RuntimeHostedRootExecutionInput): Promise<void>;
  stopRoot(
    identity: RuntimeMessageRunIdentity,
    input?: {
      source?: 'stop_button' | 'graph_supervisor';
      mode?: BackendStopMode;
    },
  ): Promise<void>;
  stopSession(
    sessionId: string,
    input?: {
      source?: 'stop_button' | 'graph_supervisor';
      mode?: BackendStopMode;
    },
  ): Promise<void>;
}

export function isRuntimeHostedRootAuthority(
  authority: RuntimeMessageAuthority | undefined,
): authority is RuntimeHostedRootAuthority {
  return (
    authority !== undefined &&
    'executeRoot' in authority &&
    typeof authority.executeRoot === 'function' &&
    'stopRoot' in authority &&
    typeof authority.stopRoot === 'function' &&
    'stopSession' in authority &&
    typeof authority.stopSession === 'function'
  );
}

export class RuntimeMessageAuthorityInvariantError extends Error {
  readonly name = 'RuntimeMessageAuthorityInvariantError';
}

export class RuntimeHostedRootConflictError extends Error {
  readonly name = 'RuntimeHostedRootConflictError';
  readonly code = 'session_busy';
  readonly scope: { readonly kind: 'session'; readonly sessionId: string };

  constructor(sessionId: string, message: string) {
    super(message);
    this.scope = { kind: 'session', sessionId };
  }
}

export class RuntimeHostedRootUnavailableError extends Error {
  readonly name = 'RuntimeHostedRootUnavailableError';
  readonly code = 'session_unavailable';
  readonly scope: { readonly kind: 'session'; readonly sessionId: string };

  constructor(sessionId: string, message: string, options: ErrorOptions = {}) {
    super(message, options);
    this.scope = { kind: 'session', sessionId };
  }
}
