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

import type { SessionEvent } from '@maka/core/events';
import type { MakaToolContext } from './tool-runtime.js';

export const CHILD_AGENT_PROGRESS_MAX_EVENTS = 64;
export const CHILD_AGENT_PROGRESS_MAX_CHARS = 8_192;
export const CHILD_AGENT_PROGRESS_BATCH_MAX_EVENTS = 128;
export const CHILD_AGENT_PROGRESS_BATCH_MAX_CHARS = 16_384;

export interface ChildAgentProgressBudget {
  readonly maxEvents: number;
  readonly maxChars: number;
  projectedEvents: number;
  projectedChars: number;
}

export interface ChildAgentProgressProjectorOptions {
  prefix?: string;
  sharedBudget?: ChildAgentProgressBudget;
}

export function createChildAgentProgressBudget(
  maxEvents: number,
  maxChars: number,
): ChildAgentProgressBudget {
  return {
    maxEvents,
    maxChars,
    projectedEvents: 0,
    projectedChars: 0,
  };
}

export class ChildAgentProgressProjector {
  private readonly tools = new Map<string, string>();
  private readonly prefix: string;
  private projectedEvents = 0;
  private projectedChars = 0;

  constructor(
    private readonly ctx: Pick<MakaToolContext, 'emitOutput'>,
    private readonly options: ChildAgentProgressProjectorOptions = {},
  ) {
    this.prefix = options.prefix ?? 'Child';
  }

  observe(event: SessionEvent): void {
    if (event.type === 'tool_start') {
      if (!this.hasCapacity()) return;
      const name = event.displayName ?? event.toolName;
      this.tools.set(event.toolUseId, name);
      this.emit('stdout', `${this.prefix} tool started: ${name}\n`);
      return;
    }
    if (event.type === 'tool_result') {
      const name = this.tools.get(event.toolUseId) ?? 'tool';
      this.tools.delete(event.toolUseId);
      this.emit(
        event.isError ? 'stderr' : 'stdout',
        `${this.prefix} tool ${event.isError ? 'failed' : 'finished'}: ${name}\n`,
      );
      return;
    }
    if (event.type === 'provider_retry') {
      const retry =
        event.phase === 'scheduled'
          ? `scheduled: attempt ${event.attempt}/${event.maxAttempts} in ${event.delayMs}ms`
          : `started: attempt ${event.attempt}/${event.maxAttempts}`;
      this.emit('stderr', `${this.prefix} provider retry ${retry} (${event.reason})\n`);
    }
  }

  private emit(stream: 'stdout' | 'stderr', chunk: string): void {
    if (!this.hasCapacity()) return;
    const shared = this.options.sharedBudget;
    const localRemaining = CHILD_AGENT_PROGRESS_MAX_CHARS - this.projectedChars;
    const sharedRemaining = shared ? shared.maxChars - shared.projectedChars : localRemaining;
    const remaining = Math.min(localRemaining, sharedRemaining);

    const bounded = chunk.slice(0, remaining);
    this.projectedEvents += 1;
    this.projectedChars += bounded.length;
    if (shared) {
      shared.projectedEvents += 1;
      shared.projectedChars += bounded.length;
    }
    this.ctx.emitOutput(stream, bounded);
  }

  private hasCapacity(): boolean {
    const shared = this.options.sharedBudget;
    return (
      this.projectedEvents < CHILD_AGENT_PROGRESS_MAX_EVENTS &&
      this.projectedChars < CHILD_AGENT_PROGRESS_MAX_CHARS &&
      (!shared ||
        (shared.projectedEvents < shared.maxEvents && shared.projectedChars < shared.maxChars))
    );
  }
}
