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
import { Button, IconButton } from '@astryxdesign/core';
import { MakaWordmark } from './maka-wordmark.js';

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
      <Button className="maka-progress-card-primary" size="sm" variant="ghost"
        label={props.primaryAction.label} endContent={props.primaryAction.icon}
        aria-expanded={props.primaryAction.expanded} aria-controls={props.primaryAction.controls} onClick={props.primaryAction.onClick}>
        <span className="maka-progress-card-status" role="status"><i data-active={props.active} aria-hidden="true" />{props.status}</span>
      </Button>
      {props.secondaryAction && <IconButton className="maka-progress-card-action" size="sm" variant="ghost"
        label={props.secondaryAction.label} icon={props.secondaryAction.icon} onClick={props.secondaryAction.onClick} />}
    </div>
    {props.summary && <p className="maka-progress-card-summary">{props.summary.replace(/\s+/g, ' ').trim()}</p>}
  </aside>;
}
