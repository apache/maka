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

export type GoalTaskGateDecision =
  | 'evaluator_terminal'
  | 'goal_stopped'
  | 'no_actionable_tasks'
  | 'reminder_injected'
  | 'reminder_limit_reached';

export interface GoalTaskGateTrace {
  sessionId: string;
  turnId: string;
  goalId: string;
  decision: GoalTaskGateDecision;
  taskKeys: string[];
}

export interface GoalTaskGateDeps {
  /** List only pending/in_progress tasks. Blocked and terminal tasks are excluded. */
  listActionableTaskKeys: (sessionId: string) => Promise<string[]>;
  recordDecision?: (trace: GoalTaskGateTrace) => Promise<void>;
}

interface GoalTaskGateAdmissionPlan {
  readonly taskKeys: string[];
  readonly decision: Exclude<GoalTaskGateDecision, 'evaluator_terminal' | 'goal_stopped'>;
  readonly reminder?: string;
}

const TASK_GATE_REMINDER =
  '[Task reminder] Actionable session tasks remain. Reconcile them before stopping: finish them with real evidence, ' +
  'or update their status truthfully. A task is advisory and never overrides files, tests, artifacts, or verifier evidence.';

/** Owns the advisory task reminder budget and best-effort decision tracing. */
export class GoalTaskGatePolicy {
  private readonly remindedGoalIds = new Set<string>();

  constructor(private readonly deps: GoalTaskGateDeps | undefined) {}

  async listActionable(sessionId: string): Promise<string[]> {
    if (!this.deps) return [];
    try {
      return await this.deps.listActionableTaskKeys(sessionId);
    } catch {
      return [];
    }
  }

  async planAdmission(sessionId: string, goalId: string): Promise<GoalTaskGateAdmissionPlan> {
    const taskKeys = await this.listActionable(sessionId);
    if (taskKeys.length === 0) {
      return { taskKeys, decision: 'no_actionable_tasks' };
    }
    if (this.remindedGoalIds.has(goalId)) {
      return { taskKeys, decision: 'reminder_limit_reached' };
    }
    return {
      taskKeys,
      decision: 'reminder_injected',
      reminder: `${TASK_GATE_REMINDER}\nActionable task keys: ${taskKeys.join(', ')}`,
    };
  }

  markStarted(goalId: string, plan: GoalTaskGateAdmissionPlan): void {
    if (plan.decision === 'reminder_injected') this.remindedGoalIds.add(goalId);
  }

  record(trace: GoalTaskGateTrace): void {
    if (!this.deps?.recordDecision) return;
    void this.deps.recordDecision(trace).catch(() => {});
  }
}
