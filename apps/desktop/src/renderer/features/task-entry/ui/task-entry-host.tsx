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

import type { ProjectRecord } from '@maka/core/project';
import { RemoteProjectDirectoryDialog } from '../../../remote-project-directory-dialog.js';
import type { TaskEntryHostRef } from '../ports.js';

export interface TaskEntryHostModel {
  directoryHost?: TaskEntryHostRef & { readonly name?: string };
  directoryOpener?: HTMLElement | null;
  closeDirectoryPicker(): void;
  acceptRegisteredProject(
    project: ProjectRecord,
    host: TaskEntryHostRef,
  ): Promise<void>;
}

export function TaskEntryHost({ model }: { model: TaskEntryHostModel }) {
  return (
    <RemoteProjectDirectoryDialog
      host={model.directoryHost}
      returnFocusTo={model.directoryOpener}
      onClose={model.closeDirectoryPicker}
      onRegistered={(project, host) => {
        void model.acceptRegisteredProject(project, host);
      }}
    />
  );
}
