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

import type { GoalProjection, PlanQueryResult } from '@maka/runtime-host/protocol';

export interface AcpPlanChanged {
  readonly sessionId: string;
  readonly storeVersion: number;
  readonly latestProposalId: string | null;
  readonly activeExecutionId: string | null;
}

export interface AcpGoalStatus {
  readonly sessionId: string;
  readonly goal: GoalProjection | null;
}

/** Latest authoritative domain state for one retained Session attachment. */
export class AcpSessionDomainObservation {
  readonly #sessionId: string;
  readonly #queryPlan: () => Promise<PlanQueryResult>;
  readonly #goalNotify: () => ((status: AcpGoalStatus) => Promise<void>) | undefined;
  readonly #planNotify: () => ((status: AcpPlanChanged) => Promise<void>) | undefined;
  #disposed = false;
  #epoch = 0;
  #goal: GoalProjection | null = null;
  #goalKnown = false;
  #goalDelivered?: string;
  #planDelivered?: number;
  #planSeen?: number;
  #planDirty = false;
  #planRefresh?: Promise<void>;
  #planRetryCount = 0;
  #planRetryTimer?: ReturnType<typeof setTimeout>;
  #goalDelivery?: Promise<void>;
  #planDelivery?: Promise<void>;
  #pendingGoal?: AcpGoalStatus;
  #pendingPlan?: AcpPlanChanged;

  constructor(options: {
    sessionId: string;
    queryPlan: () => Promise<PlanQueryResult>;
    goalNotify: () => ((status: AcpGoalStatus) => Promise<void>) | undefined;
    planNotify: () => ((status: AcpPlanChanged) => Promise<void>) | undefined;
  }) {
    this.#sessionId = options.sessionId;
    this.#queryPlan = options.queryPlan;
    this.#goalNotify = options.goalNotify;
    this.#planNotify = options.planNotify;
  }

  initialize(goal: GoalProjection | null): void {
    this.goalChanged(goal);
    this.planChanged();
  }

  goalChanged(goal: GoalProjection | null): void {
    if (this.#disposed) return;
    if (
      this.#goalKnown &&
      goal?.goalId === this.#goal?.goalId &&
      (goal?.revision ?? -1) < (this.#goal?.revision ?? -1)
    )
      return;
    this.#goalKnown = true;
    this.#goal = goal;
    // Even a return to the last delivered value must replace an older pending
    // snapshot: an in-flight notification may still change what the client sees.
    this.#pendingGoal = { sessionId: this.#sessionId, goal };
    this.#sendGoal();
  }

  planChanged(): void {
    if (this.#disposed) return;
    if (!this.#planNotify()) return;
    if (this.#planRetryTimer) {
      clearTimeout(this.#planRetryTimer);
      this.#planRetryTimer = undefined;
    }
    this.#planRetryCount = 0;
    this.#planDirty = true;
    this.#kickPlan();
  }

  #kickPlan(): void {
    if (!this.#planRefresh) {
      this.#planRefresh = this.#refreshPlan().finally(() => {
        this.#planRefresh = undefined;
        if (this.#planDirty && !this.#disposed && !this.#planRetryTimer && this.#planRetryCount < 4)
          this.#kickPlan();
      });
    }
  }

  canonicalReplacement(goal: GoalProjection | null): void {
    this.#epoch += 1;
    this.#goalDelivered = undefined;
    this.#planDelivered = undefined;
    this.#planSeen = undefined;
    this.#goalKnown = false;
    this.initialize(goal);
  }

  dispose(): void {
    this.#disposed = true;
    this.#epoch += 1;
    this.#pendingGoal = undefined;
    this.#pendingPlan = undefined;
    this.#planDirty = false;
    if (this.#planRetryTimer) clearTimeout(this.#planRetryTimer);
    this.#planRetryTimer = undefined;
  }

  async #refreshPlan(): Promise<void> {
    // A frame received during a read is folded into one follow-up read.
    while (this.#planDirty && !this.#disposed) {
      this.#planDirty = false;
      const epoch = this.#epoch;
      try {
        const result = await this.#queryPlan();
        if (this.#disposed || epoch !== this.#epoch || result.kind !== 'page') continue;
        this.#planRetryCount = 0;
        if (this.#planSeen !== undefined && result.storeVersion < this.#planSeen) continue;
        this.#planSeen = result.storeVersion;
        const status: AcpPlanChanged = {
          sessionId: this.#sessionId,
          storeVersion: result.storeVersion,
          latestProposalId: result.latestProposalId,
          activeExecutionId: result.activeExecutionId,
        };
        if (result.storeVersion !== this.#planDelivered) {
          this.#pendingPlan = status;
          this.#sendPlan();
        }
      } catch (error) {
        console.error('[acp] Plan status refresh failed:', error);
        this.#planDirty = true;
        this.#planRetryCount += 1;
        if (this.#planRetryCount <= 3 && !this.#disposed) {
          this.#planRetryTimer = setTimeout(
            () => {
              this.#planRetryTimer = undefined;
              this.#kickPlan();
            },
            25 * 2 ** (this.#planRetryCount - 1),
          );
        }
        break;
      }
    }
  }

  #sendGoal(): void {
    if (this.#goalDelivery || !this.#pendingGoal || this.#disposed) return;
    const notify = this.#goalNotify();
    if (!notify) return;
    const status = this.#pendingGoal;
    const epoch = this.#epoch;
    this.#pendingGoal = undefined;
    const key = JSON.stringify(status);
    if (key === this.#goalDelivered) return;
    this.#goalDelivery = notify(status)
      .then(() => {
        if (!this.#disposed && epoch === this.#epoch) this.#goalDelivered = key;
      })
      .catch((error: unknown) => console.error('[acp] Goal status delivery failed:', error))
      .finally(() => {
        this.#goalDelivery = undefined;
        this.#sendGoal();
      });
  }

  #sendPlan(): void {
    if (this.#planDelivery || !this.#pendingPlan || this.#disposed) return;
    const notify = this.#planNotify();
    if (!notify) return;
    const status = this.#pendingPlan;
    const epoch = this.#epoch;
    this.#pendingPlan = undefined;
    this.#planDelivery = notify(status)
      .then(() => {
        if (!this.#disposed && epoch === this.#epoch) this.#planDelivered = status.storeVersion;
      })
      .catch((error: unknown) => console.error('[acp] Plan status delivery failed:', error))
      .finally(() => {
        this.#planDelivery = undefined;
        this.#sendPlan();
      });
  }
}
