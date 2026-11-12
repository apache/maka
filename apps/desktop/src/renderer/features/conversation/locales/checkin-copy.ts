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

import type { CheckinCardAction } from '@maka/core/session-checkin';
import {
  type UiCatalog,
  type UiLocale,
  defineShippedUiMessageCatalog,
  resolveUiMessageCatalog,
} from '@maka/core/ui-locale';

export interface CheckinCopy {
  readonly sectionLabel: string;
  readonly running: string;
  readonly actions: Record<CheckinCardAction, string>;
  readonly dismiss: string;
  /** Opens the card's task with its action in that task's Composer, to rewrite. */
  readonly instead: string;
  /** Heads the record's words that justify the card. */
  readonly why: string;
  from(sessionName: string): string;
  /** Shown when a resume card carries no instruction of its own. */
  readonly resumeHint: string;
  readonly stale: string;
  readonly failed: string;
}

const en: CheckinCopy = {
  sectionLabel: 'Check-in',
  running: 'Looking at what changed while you were away…',
  actions: { resume: 'Resume', continue: 'Continue', new_session: 'New task', answer: 'Answer' },
  dismiss: 'Dismiss',
  instead: 'Change',
  why: 'Why this card',
  from: (sessionName) => `From: ${sessionName}`,
  resumeHint: 'Pick up the last run where it stopped.',
  stale: 'This task changed since the check-in, so it was only opened.',
  failed: 'The action did not start. The task is open so you can continue there.',
};

const zhCN: CheckinCopy = {
  sectionLabel: '签到',
  running: '正在看你离开期间的进展…',
  actions: { resume: '恢复', continue: '继续', new_session: '新任务', answer: '去回答' },
  dismiss: '忽略',
  instead: '改成别的',
  why: '为什么出这张卡',
  from: (sessionName) => `来自：${sessionName}`,
  resumeHint: '从上次停下的地方接着运行。',
  stale: '签到之后这个任务有了变化，所以只帮你打开了它。',
  failed: '动作没有开始。任务已经打开，可以在那里继续。',
};

const zhTW: CheckinCopy = {
  sectionLabel: '簽到',
  running: '正在看你離開期間的進展…',
  actions: { resume: '恢復', continue: '繼續', new_session: '新任務', answer: '去回答' },
  dismiss: '忽略',
  instead: '改成別的',
  why: '為什麼出這張卡',
  from: (sessionName) => `來自：${sessionName}`,
  resumeHint: '從上次停下的地方接著執行。',
  stale: '簽到之後這個任務有了變化，所以只幫你開啟了它。',
  failed: '動作沒有開始。任務已經開啟，可以在那裡繼續。',
};

const COPY = resolveUiMessageCatalog(
  defineShippedUiMessageCatalog<CheckinCopy>()({ 'zh-CN': zhCN, 'zh-TW': zhTW, en }),
) satisfies UiCatalog<CheckinCopy>;

export function getCheckinCopy(locale: UiLocale): CheckinCopy {
  return COPY[locale];
}
