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

import { memo, useState } from 'react';
import type { MessageQueueEntryProjection } from '@maka/core/events';
import { IconButton } from '@astryxdesign/core';
import type { ConversationCopy } from './conversation-copy.js';
import { CornerDownRight, ListEnd, Undo2 } from './icons.js';
import { useMountedRef } from './use-mounted-ref.js';

export interface ComposerMessageQueueProps {
  queuedMessages: {
    steering: readonly MessageQueueEntryProjection[];
    followup: readonly MessageQueueEntryProjection[];
  };
  copy: ConversationCopy['composer'];
  onRetractQueued?(): void | Promise<void>;
}

export const ComposerMessageQueue = memo(function ComposerMessageQueue(
  props: ComposerMessageQueueProps,
) {
  const [retractPending, setRetractPending] = useState(false);
  const mountedRef = useMountedRef();
  const entries = [
    ...props.queuedMessages.steering.map((entry) => ({
      entry,
      label: entry.state === 'in_flight'
        ? props.copy.steerDeliveringLabel
        : props.copy.steerQueuedLabel,
    })),
    ...props.queuedMessages.followup.map((entry) => ({
      entry,
      label: props.copy.followUpQueuedLabel,
    })),
  ];

  async function retractQueued() {
    if (!props.onRetractQueued || retractPending) return;
    setRetractPending(true);
    try {
      await props.onRetractQueued();
    } finally {
      if (mountedRef.current) setRetractPending(false);
    }
  }

  return (
    <div
      className="maka-composer-queue"
      role="region"
      aria-label={props.copy.queuedMessagesAriaLabel(entries.length)}
    >
      <div className="maka-composer-queue-list">
        {entries.map(({ entry, label }) => (
          <div className="maka-composer-queue-row" key={entry.entryId}>
            {entry.placement === 'current_turn'
              ? <CornerDownRight size={14} aria-hidden="true" />
              : <ListEnd size={14} aria-hidden="true" />}
            <span className="maka-composer-queue-kind">{label}</span>
            <span className="maka-composer-queue-text">
              {entry.content.displayText ?? entry.content.text}
            </span>
          </div>
        ))}
      </div>
      {props.onRetractQueued ? (
        <IconButton
          variant="ghost"
          size="sm"
          type="button"
          isDisabled={retractPending}
          label={props.copy.retractQueued}
          tooltip={props.copy.retractQueued}
          onClick={() => void retractQueued()}
          icon={<Undo2 size={14} aria-hidden="true" />}
        />
      ) : null}
    </div>
  );
});
