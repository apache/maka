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

import type { UiLocale } from '@maka/core/ui-locale';
import { classifiedErrorFallback } from '../../../application/contracts/operation-diagnostics.js';
import { isSessionWorkspaceUnavailableError } from '../../../application/contracts/session-workspace-errors.js';
import {
  getShellCopy,
  openPathActionLabel,
  openPathFailureCopy,
} from '../../../locales/shell-copy.js';
import type { TaskEntryError, TaskEntryFolder, TaskEntryFolderOpenResult } from '../ports.js';

/**
 * What to report for a folder that did not open, or undefined when it opened.
 * The words are the shell's open-folder copy; a task whose workspace is gone
 * gets the workspace-unavailable notice instead of an open failure.
 */
export function folderOpenFailure(
  folder: TaskEntryFolder,
  result: TaskEntryFolderOpenResult,
  locale: UiLocale,
  sessionId?: string,
): TaskEntryError | undefined {
  if (result.kind === 'opened') return undefined;
  const copy = getShellCopy(locale);
  const title = copy.projectActions.openFailedTitle(openPathActionLabel(folder, locale));
  if (result.kind === 'refused') {
    return {
      title,
      description: openPathFailureCopy(result.reason, locale),
      ...result.diagnosticTarget,
    };
  }
  if (sessionId && isSessionWorkspaceUnavailableError(result.error)) {
    return {
      title: copy.errors.workspaceUnavailableTitle,
      description: copy.errors.workspaceUnavailableDescription,
      sessionId,
    };
  }
  return {
    title,
    description: classifiedErrorFallback(
      result.error,
      copy.errors.openPath(copy.paths[folder]),
      locale,
      `open-path:${folder}`,
    ),
    ...result.diagnosticTarget,
  };
}
