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

import type { TaskSubmissionReadinessSnapshot } from '@maka/core/task-submission-readiness';
import { createServicesContext } from '../../application/contracts/feature-services.js';
import type { ConversationNewTaskTarget } from './ports.js';

/** The model target and workspace a readiness probe checks. */
export interface TaskReadinessRequest {
  readonly connectionSlug?: string;
  readonly model?: string;
  readonly cwd?: string;
}

/** The two Host reads behind the Composer's readiness notice; nothing else. */
export interface TaskReadinessServices {
  readSession(sessionId: string, request: TaskReadinessRequest): Promise<TaskSubmissionReadinessSnapshot>;
  readNewTask(target: ConversationNewTaskTarget, request: TaskReadinessRequest): Promise<TaskSubmissionReadinessSnapshot>;
}

const context = createServicesContext<TaskReadinessServices>('TaskReadinessServicesProvider');
export const TaskReadinessServicesProvider = context.Provider;
export const useTaskReadinessServices = context.useServices;
