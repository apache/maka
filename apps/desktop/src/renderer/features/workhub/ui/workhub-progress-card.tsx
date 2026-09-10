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

import { useEffect } from 'react';
import { Button, IconButton } from '@astryxdesign/core';
import { MakaWordmark, useUiLocale, type LiveTurnProjection } from '@maka/ui';
import { ArrowRight, X } from '@maka/ui/icons';
import type { StoredMessage } from '@maka/core/session';
import type { WorkHubControlSnapshot } from '../../../../shared/workhub-control.js';
import { useWorkHubServices } from '../services.js';
import { workHubLiveCopy } from '../locales/workhub-live-copy.js';

function latestText(liveTurn: LiveTurnProjection | undefined, messages: readonly StoredMessage[]): string | undefined {
  for (let index = (liveTurn?.steps.length ?? 0) - 1; index >= 0; index--) {
    const text = liveTurn!.steps[index]?.text?.text;
    if (text?.trim()) return text;
  }
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    if (message.type === 'assistant' && (!liveTurn || message.turnId === liveTurn.turnId) && message.text.trim()) return message.text;
  }
  return undefined;
}

export function WorkHubProgressCard({ request, control, liveTurn, messages, busy }: {
  request: number;
  control?: WorkHubControlSnapshot;
  liveTurn?: LiveTurnProjection;
  messages: readonly StoredMessage[];
  busy: boolean;
}) {
  const { presentation } = useWorkHubServices();
  const t = workHubLiveCopy[useUiLocale()];
  const status = control?.phase === 'paused' ? t.progressPaused : control?.phase === 'error' ? t.progressError
    : control?.status ?? (busy || control?.phase === 'acting' ? t.progressWorking : t.progressDone);
  const spoken = latestText(liveTurn, messages)?.trim().split(/(?<=[。！？!?])\s*|(?<=\.)\s+|\n+/u).filter(Boolean).at(-1);
  useEffect(() => {
    let second = 0;
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => { void presentation.progressReady(request).catch(console.error); });
    });
    return () => { cancelAnimationFrame(first); cancelAnimationFrame(second); };
  }, [presentation, request]);
  return <aside className="workHubProgressCard" aria-label={t.progressTitle}>
    <div className="workHubProgressHeader">
      <span className="workHubProgressBrand"><MakaWordmark width={42} /></span>
      <span className="workHubProgressStatus" role="status"><i data-active={busy || control?.phase === 'acting'} />{status}</span>
      <IconButton className="workHubProgressClose" size="sm" variant="ghost" icon={<X size={12} />} label={t.progressClose} onClick={() => { void presentation.hide().catch(console.error); }} />
    </div>
    <p className="workHubProgressText">{spoken?.replace(/\s+/g, ' ').trim() || t.progressHint}</p>
    <Button className="workHubProgressOpen" size="sm" variant="ghost" label={t.progressOpen} endContent={<ArrowRight size={12} />} onClick={() => { void presentation.showConversation().catch(console.error); }} />
  </aside>;
}
