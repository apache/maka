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

import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { useUiLocale } from '@maka/ui';
import { getDesktopConversationCopy } from '../../../../locales/conversation-copy.js';
import type { VisibleParentTaskStatus } from '../../model/parent-task-status.js';

const BANNER_STATUS = {
  waiting_input: 'warning',
  waiting_approval: 'warning',
  waiting_input_and_approval: 'warning',
  running: 'info',
  last_turn_completed: 'success',
  last_turn_failed: 'error',
  last_turn_interrupted: 'warning',
  unavailable: 'warning',
} as const;

export function ParentTaskStatusNotice(props: {
  status: VisibleParentTaskStatus;
  onOpenParentConversation?: () => void;
}) {
  const locale = useUiLocale();
  const copy = getDesktopConversationCopy(locale).quoteCompanion.parentStatus;
  const title = {
    waiting_input: copy.waitingInput,
    waiting_approval: copy.waitingApproval,
    waiting_input_and_approval: copy.waitingInputAndApproval,
    running: copy.running,
    last_turn_completed: copy.lastTurnCompleted,
    last_turn_failed: copy.lastTurnFailed,
    last_turn_interrupted: copy.lastTurnInterrupted,
    unavailable: copy.unavailable,
  }[props.status];
  return (
    <div
      className="maka-quote-companion-parent-status"
      data-maka-contract="side-chat-parent-status"
      data-status={props.status}
    >
      <Banner
        status={BANNER_STATUS[props.status]}
        container="section"
        title={title}
        endContent={
          props.onOpenParentConversation ? (
            <Button
              variant="secondary"
              size="sm"
              label={copy.openParent}
              onClick={props.onOpenParentConversation}
            />
          ) : undefined
        }
      />
    </div>
  );
}
