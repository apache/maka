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

import type { PetSurface } from '../../application/contracts/pet-desktop.js';
import { projectTasks } from './task-float-model.js';

/** Sleep is only the Bot's state, never proof that its delegated work is done. */
export function projectAssistantPet(result: any, sessionId?: string): PetSurface {
  const tasks = projectTasks(result.tasks);
  const running = tasks.filter(t => t.phase === 'running').length;
  const waiting = tasks.filter(t => t.phase === 'waiting').length;
  const attention = tasks.filter(t => t.phase === 'attention' || t.phase === 'queued').length;
  const discovery = !!result.state?.active;
  const unavailable = result.tasks?.error || result.bot?.error || result.bot?.wakeError;
  const label = unavailable ? '状态需要检查' :
    discovery ? '正在发现值得关注的事情' : result.bot?.working ? '正在回复你' :
    attention ? '有事情等你处理' : running ? '正在帮你推进事情' :
    waiting ? '等待后续进展' : (sessionId ? '暂时没有待处理的事' : '还没有助手会话');
  return { sessionId, label,
    runningTasks: tasks.filter(t => t.phase === 'running').map(t => ({ id:t.id, title:t.title || '正在处理任务' })),
    discoveryRun: result.state?.active ? { id: result.state.active.id, running: true } :
      result.state?.lastRun ? { id: result.state.lastRun.id, running: false, outcome: result.state.lastRun.outcome } : undefined,
    maintenance: result.memoryActivity?.map((m: any) => ({ id: `${m.id}:${m.attempt}`, running: m.running, error: m.error })),
    discovery: discovery ? '主动发现进行中' : result.state?.lastError ? '主动发现异常，请检查' :
      result.state?.enabled ? '主动发现等待下一轮' : '主动发现未开启',
    tasks: result.tasks?.error ? undefined : { running, waiting, attention },
    activity: unavailable ? 'blocked' : attention ? 'needs-input' :
      discovery ? 'swarm' : running || result.bot?.working ? 'working' : 'idle' };
}
