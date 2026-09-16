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

import type { ReactNode } from 'react';
import { Banner, Button } from '@maka/ui';
import type { SessionHealthNoticeView } from './use-shell-chat-model';

/** One composer-adjacent recovery surface: shared placement and action hierarchy. */
export function ChatRecoveryNotice(props: {
  status: 'error' | 'warning' | 'info';
  title: ReactNode;
  description?: ReactNode;
  actionLabel?: string;
  actionDisabled?: boolean;
  onAction?: () => void;
}) {
  return (
    <div className="maka-chat-recovery-notice">
      <Banner
        status={props.status}
        className="maka-chat-recovery-notice-alert"
        role="status"
        title={props.title}
        description={props.description}
        endContent={props.actionLabel && props.onAction ? (
          <Button
            label={props.actionLabel}
            variant="secondary"
            size="sm"
            isDisabled={props.actionDisabled}
            onClick={props.onAction}
          />
        ) : undefined}
      />
    </div>
  );
}

/** Production adapter from Session health routing to the shared notice surface. */
export function SessionHealthRecoveryNotice(props: {
  notice: SessionHealthNoticeView;
  fallbackActionLabel: string;
  modelPickerAvailable: boolean;
}) {
  const { notice } = props;
  const actionDisabled =
    notice.actionDisabled ||
    (notice.onClickTarget === 'model_picker' && !props.modelPickerAvailable);
  return (
    <ChatRecoveryNotice
      status={notice.tone === 'destructive' ? 'error' : notice.tone}
      title={notice.label}
      description={notice.tooltip}
      actionLabel={notice.actionLabel ?? props.fallbackActionLabel}
      actionDisabled={actionDisabled}
      onAction={notice.onClick}
    />
  );
}
