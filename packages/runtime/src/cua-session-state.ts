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

export const CUA_SESSION_STATUSES = [
  'unobserved',
  'active',
  'intervention_debounce',
  'reobserve_required',
  'screen_locked',
  'blocked_url',
  'user_stopped',
] as const;

export type CuaSessionStatus = (typeof CUA_SESSION_STATUSES)[number];

export type CuaSessionActionBlockReason =
  | 'no_active_frame'
  | 'user_intervened'
  | 'reobserve_required'
  | 'screen_locked'
  | 'blocked_url'
  | 'user_stopped';

export interface CuaActionLease {
  sessionId: string;
  generation: number;
}

export type CuaActionLeaseResult =
  | { ok: true; lease: CuaActionLease }
  | { ok: false; reason: CuaSessionActionBlockReason };

export type CuaObservationLeaseResult = CuaActionLeaseResult;

export interface CuaSessionSnapshot {
  status: CuaSessionStatus;
  generation: number;
}

export class CuaSessionState {
  private status: CuaSessionStatus = 'unobserved';
  private generation = 0;

  constructor(readonly sessionId: string) {}

  snapshot(): CuaSessionSnapshot {
    return { status: this.status, generation: this.generation };
  }

  beforeAction(): CuaActionLeaseResult {
    return this.status === 'active'
      ? {
          ok: true,
          lease: { sessionId: this.sessionId, generation: this.generation },
        }
      : { ok: false, reason: blockReason(this.status) };
  }

  beforeObservation(): CuaObservationLeaseResult {
    return this.canObserve()
      ? {
          ok: true,
          lease: { sessionId: this.sessionId, generation: this.generation },
        }
      : { ok: false, reason: blockReason(this.status) };
  }

  validateObservationLease(lease: CuaActionLease): CuaObservationLeaseResult {
    return this.sameGeneration(lease) && this.canObserve()
      ? { ok: true, lease }
      : { ok: false, reason: blockReason(this.status) };
  }

  validateLease(lease: CuaActionLease): CuaActionLeaseResult {
    return this.sameGeneration(lease) && this.status === 'active'
      ? { ok: true, lease }
      : { ok: false, reason: blockReason(this.status) };
  }

  freshObservationSucceeded(): CuaSessionSnapshot {
    if (!this.canObserve()) {
      return this.snapshot();
    }
    return this.transition('active');
  }

  physicalUserIntervened(): CuaSessionSnapshot {
    if (this.isTerminal()) return this.snapshot();
    return this.transition('intervention_debounce');
  }

  interventionDebounceElapsed(): CuaSessionSnapshot {
    return this.status === 'intervention_debounce'
      ? this.transition('reobserve_required')
      : this.snapshot();
  }

  reobserveRequired(): CuaSessionSnapshot {
    if (this.isTerminal()) return this.snapshot();
    return this.transition('reobserve_required');
  }

  screenLocked(): CuaSessionSnapshot {
    if (this.isTerminal()) return this.snapshot();
    return this.transition('screen_locked');
  }

  screenUnlocked(): CuaSessionSnapshot {
    return this.status === 'screen_locked'
      ? this.transition('reobserve_required')
      : this.snapshot();
  }

  blockedUrlDetected(): CuaSessionSnapshot {
    if (this.isTerminal()) return this.snapshot();
    return this.transition('blocked_url');
  }

  userStopped(): CuaSessionSnapshot {
    if (this.isTerminal()) return this.snapshot();
    return this.transition('user_stopped');
  }

  dynamicContentChanged(): CuaSessionSnapshot {
    return this.snapshot();
  }

  private sameGeneration(lease: CuaActionLease): boolean {
    return lease.sessionId === this.sessionId && lease.generation === this.generation;
  }

  private canObserve(): boolean {
    return (
      this.status === 'unobserved' ||
      this.status === 'active' ||
      this.status === 'reobserve_required'
    );
  }

  private isTerminal(): boolean {
    return this.status === 'blocked_url' || this.status === 'user_stopped';
  }

  private transition(status: CuaSessionStatus): CuaSessionSnapshot {
    this.generation += 1;
    this.status = status;
    return this.snapshot();
  }
}

function blockReason(status: CuaSessionStatus): CuaSessionActionBlockReason {
  switch (status) {
    case 'unobserved':
      return 'no_active_frame';
    case 'active':
      return 'reobserve_required';
    case 'intervention_debounce':
      return 'user_intervened';
    case 'reobserve_required':
      return 'reobserve_required';
    case 'screen_locked':
      return 'screen_locked';
    case 'blocked_url':
      return 'blocked_url';
    case 'user_stopped':
      return 'user_stopped';
  }
}
