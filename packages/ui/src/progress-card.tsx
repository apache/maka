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

import type { ReactNode, Ref } from 'react';
import { IconButton } from '@astryxdesign/core';
import { MakaWordmark } from './maka-wordmark.js';

export const progressStatusCopy = {
  en: { working: 'Working', paused: 'Paused', attention: 'Needs attention', finished: 'Finished', openConversation: 'View full conversation' },
  'zh-CN': { working: '正在处理', paused: '已暂停', attention: '需要查看', finished: '本轮已结束', openConversation: '查看完整对话' },
  'zh-TW': { working: '正在處理', paused: '已暫停', attention: '需要查看', finished: '本輪已結束', openConversation: '查看完整對話' },
};

type ProgressCardAction = {
  label: string;
  icon: ReactNode;
  onClick(): void;
  expanded?: boolean;
  controls?: string;
};

/** Shared presentation for compact agent progress; callers own execution and windows. */
export function ProgressCard(props: {
  ref?: Ref<HTMLElement>;
  className?: string;
  label: string;
  status: string;
  active: boolean;
  summary?: string;
  primaryAction: ProgressCardAction;
  secondaryAction?: ProgressCardAction;
}) {
  return <aside ref={props.ref} className={['maka-progress-card', props.className].filter(Boolean).join(' ')} aria-label={props.label}>
    <div className="maka-progress-card-header">
      <span className="maka-progress-card-brand"><MakaWordmark width={42} /></span>
      <span className="maka-progress-card-status" role="status"><i data-active={props.active} aria-hidden="true" />{props.status}</span>
      <IconButton className="maka-progress-card-primary" size="sm" variant="ghost"
        label={props.primaryAction.label} tooltip={props.primaryAction.label} icon={props.primaryAction.icon}
        aria-expanded={props.primaryAction.expanded} aria-controls={props.primaryAction.controls} onClick={props.primaryAction.onClick} />
      {props.secondaryAction && <IconButton className="maka-progress-card-action" size="sm" variant="ghost"
        label={props.secondaryAction.label} icon={props.secondaryAction.icon} onClick={props.secondaryAction.onClick} />}
    </div>
    {props.summary && <p className="maka-progress-card-summary">{props.summary.replace(/\s+/g, ' ').trim()}</p>}
  </aside>;
}
