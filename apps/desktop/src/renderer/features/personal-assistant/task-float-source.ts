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

import { originalHost } from './navigation.js';
import type { PersonalAssistantPort } from './services.js';
import { projectTasks, type FloatTask } from './task-float-model.js';

export async function readFloatTasks(services: Pick<PersonalAssistantPort, 'hostSnapshot' | 'call'>, sessionId: string): Promise<FloatTask[]> {
  const target = originalHost(sessionId, (await services.hostSnapshot()).entries);
  const result = await services.call('assistant.status', { includeMemory: false }, target.host);
  if (result?.state?.sessionId !== target.sessionId) throw Error('Assistant binding changed');
  if (!result.tasks?.installed || result.tasks.error) throw Error('Task status unavailable');
  return projectTasks(result.tasks);
}

/** Sequential polling: no overlapping requests or delivery after disposal. */
export function watchFloatTasks(read: () => Promise<FloatTask[]>, receive: (tasks: FloatTask[] | null) => void, interval = 3000) {
  let live = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const refresh = async () => {
    try {
      const tasks = await read();
      if (live) receive(tasks);
    } catch {
      if (live) receive(null);
    } finally {
      if (live) timer = setTimeout(refresh, interval);
    }
  };
  void refresh();
  return () => { live = false; clearTimeout(timer); };
}
