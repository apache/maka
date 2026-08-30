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

import type { TaskEntryServices } from './ports.js';

export { TaskEntryServicesProvider } from './services-context.js';
export {
  useTaskEntryController,
  type TaskEntryController,
} from './controller/use-task-entry-controller.js';
export {
  resolveProjectSelection,
  selectAvailableProfile,
  taskEntryDraftKey,
} from './model/task-entry-selection.js';
export type {
  TaskEntryCatalog,
  TaskEntryHost,
  TaskEntryServices,
} from './ports.js';

const noopSubscription = (): (() => void) => () => undefined;

export function createFakeTaskEntryServices(
  overrides: Partial<TaskEntryServices> = {},
): TaskEntryServices {
  return {
    catalog: {
      getCatalog: async () => ({ defaultProfileId: 'local', hosts: [] }),
      subscribeChanges: noopSubscription,
      addProject: async () => ({ ok: false, reason: 'cancelled' }),
      relinkProject: async () => ({ ok: false, reason: 'cancelled' }),
    },
    ...overrides,
  };
}
