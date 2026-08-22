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

import type { DailyReviewRange } from '@maka/core/daily-review';
import type { UiLocale } from '@maka/core/ui-locale';
import type { DesktopRuntimeHostRef } from '../preload/bridge-contract.js';
import { getShellRemainingCopy } from './locales/shell-remaining-copy.js';

export function createAppShellDailyReviewBridge(locale: UiLocale = 'zh') {
  const copy = getShellRemainingCopy(locale).dailyReview;
  return {
    async fetchDay(offsetDays: number, daySpan?: number, host?: DesktopRuntimeHostRef) {
      const result = await window.maka.dailyReview.day(offsetDays, daySpan, host);
      if (!result.ok) throw new Error(result.error.message);
      return result.data;
    },
    runOnce(input: { range: DailyReviewRange; offsetDays?: number }) {
      const runOnce = window.maka.dailyReview.runOnce;
      if (!runOnce) throw new Error(copy.unavailable);
      return runOnce(input);
    },
    listArchives() {
      const listArchives = window.maka.dailyReview.listArchives;
      if (!listArchives) throw new Error(copy.historyUnavailable);
      return listArchives();
    },
    async getArchive(archiveId: string) {
      const getArchive = window.maka.dailyReview.getArchive;
      if (!getArchive) throw new Error(copy.historyUnavailable);
      const archive = await getArchive(archiveId);
      if (!archive) throw new Error(copy.archiveMissing);
      return archive;
    },
  };
}
