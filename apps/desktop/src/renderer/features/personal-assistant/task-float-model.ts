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

export type TaskPhase = 'running' | 'waiting' | 'queued' | 'attention' | 'paused' | 'completed' | 'cancelled';
export interface FloatTask {
  id: string;
  title: string;
  phase: TaskPhase;
  progress: string;
  updatedAt: number;
}
const timestamp = (value: unknown): number => {
  const result = typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : 0;
  return Number.isFinite(result) ? result : 0;
};
const text = (value: unknown): string => typeof value === 'string' ? value : '';
export function projectTasks(tasks: any, now = Date.now()): FloatTask[] {
  const items: FloatTask[] = (Array.isArray(tasks?.items) ? tasks.items : []).map((task: any) => {
    let phase: TaskPhase;
    if (task.status === 'completed' || task.status === 'cancelled') phase = task.status;
    else if (task.status === 'paused') phase = 'paused';
    else if (task.runtimeError || task.runtimeStatus === 'waiting_for_user' || task.runtimeStatus === 'blocked') phase = 'attention';
    else if (timestamp(task.retryAt) > now) phase = 'queued';
    else if (task.runtimeStatus === 'running') phase = 'running';
    else if (task.status === 'waiting') phase = 'waiting';
    else phase = 'queued';
    return {
      id: text(task.id), title: text(task.title), phase,
      progress: text(task.summary),
      updatedAt: timestamp(task.updatedAt) || timestamp(task.createdAt),
    };
  });
  for (const pending of Array.isArray(tasks?.pending) ? tasks.pending : []) {
    items.push({ id: `pending:${pending.taskKey}`, title: text(pending.title), phase: pending.status === 'needs_recovery' ? 'attention' : 'queued', progress: text(pending.message), updatedAt: 0 });
  }
  return items.filter(task => task.id).sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
}

export function visibleFloatTasks(tasks: FloatTask[], showArchived: boolean): FloatTask[] {
  return showArchived ? tasks : tasks.filter(task => !['paused', 'completed', 'cancelled'].includes(task.phase));
}
