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

import { useMemo, type ComponentProps } from 'react';
import { ChatView, useUiLocale } from '@maka/ui';
import { ICON_SIZE, ChevronRight } from '@maka/ui/icons';
import type { UiLocale } from '@maka/core/ui-locale';
import { ClickableCard, Item, Text } from '@astryxdesign/core';
import type { WorkHubLinkedWork } from '../model/linked-work.js';
import { workHubLiveCopy } from '../locales/workhub-live-copy.js';
import { deriveWorkHubTurnPresentation } from '../model/turn-presentation.js';

export function WorkHubDelegationStatus(props: {
  work: WorkHubLinkedWork;
  locale: UiLocale;
  onOpenWork(sessionId: string): void;
}) {
  const { work, onOpenWork } = props;
  const copy = workHubLiveCopy[props.locale];
  const state = work.state ?? 'accepted';
  const stateLabel = {
    accepted: copy.delegationAccepted,
    running: copy.delegationRunning,
    waiting_for_user: copy.delegationWaiting,
    completed: copy.delegationCompleted,
    failed: copy.delegationFailed,
    aborted: copy.delegationAborted,
    recovering: copy.delegationRecovering,
  }[state];
  return <ClickableCard className="workhub-delegation-status" data-work-state={state} padding={1} maxWidth={420}
    label={`${copy.openExecutionSession}: ${work.targetSessionName}`} onClick={() => onOpenWork(work.targetSessionId)}>
    <Item density="compact" label={work.targetSessionName} endContent={<span className="workhub-delegation-end">
      <Text type="supporting" color="secondary"><span role="status">{stateLabel}</span></Text>
      <ChevronRight size={ICON_SIZE.chrome} aria-hidden="true" />
    </span>} />
  </ClickableCard>;
}

export function WorkHubConversation(props: ComponentProps<typeof ChatView> & { workLinks: readonly WorkHubLinkedWork[]; onOpenWork(sessionId: string): void }) {
  const { onOpenWork, workLinks: assignments, ...chat } = props;
  const locale = useUiLocale();
  const worksByTurn = useMemo(() => {
    const grouped = new Map<string, WorkHubLinkedWork[]>();
    for (const work of assignments) {
      const works = grouped.get(work.coordinationTurnId) ?? [];
      if (!works.some((item) => item.targetSessionId === work.targetSessionId)) works.push(work);
      grouped.set(work.coordinationTurnId, works);
    }
    return grouped;
  }, [assignments]);
  const answerFooters = new Map([...worksByTurn].map(([turnId, works]) => [turnId, <div className="workhub-work-progress">
    {works.map((work) => <WorkHubDelegationStatus key={work.id} work={work} locale={locale} onOpenWork={onOpenWork} />)}
  </div>]));
  return <ChatView {...chat}
    deriveTurnPresentation={(turns) => deriveWorkHubTurnPresentation(turns, locale)}
    answerFooters={answerFooters}
  />;
}
