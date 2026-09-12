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

import { useId, useState } from 'react';
import { Button, Text } from '@astryxdesign/core';
import { ChoicePanel, presentSessionStatus, useUiLocale } from '@maka/ui';
import type { WorkHubTargetSelection, WorkHubTargetSelectionRequest } from '@maka/runtime-host/protocol';
import { workspaceNameFromCwd } from '../model/workspace-name.js';
import { workHubIdentityHue } from './workhub-work-identity.js';
import { workHubSelectionCopy } from '../locales/workhub-selection-copy.js';

export function WorkHubTargetSelector(props: {
  request: WorkHubTargetSelectionRequest;
  submitting: boolean;
  onChoose(selection: WorkHubTargetSelection): void;
  onDismiss(): void;
}) {
  const locale = useUiLocale();
  const copy = workHubSelectionCopy[locale];
  const titleId = useId();
  const [value, setValue] = useState('');
  const confirm = () => { if (value && !props.submitting) props.onChoose({ requestId: props.request.requestId, kind: 'existing', candidateRef: value }); };
  return <section className="maka-composer-interaction workhub-target-selector" aria-labelledby={titleId} aria-busy={props.submitting}>
    <div className="maka-composer-interaction-inner">
      <header className="maka-interaction-header">
        <h2 className="maka-interaction-title" id={titleId}>{copy.title}</h2>
        <Text as="p" type="supporting" color="secondary" className="workhub-selection-hint">{props.request.candidates.length ? copy.hint : copy.empty}</Text>
      </header>
      <ChoicePanel label={copy.title} value={value} onChange={setValue} disabled={props.submitting} onConfirm={confirm} onEscape={props.onDismiss}
        options={props.request.candidates.map((candidate) => ({
          value: candidate.candidateRef,
          label: candidate.sessionName,
          accentColor: `oklch(var(--workhub-identity-label-tone) ${workHubIdentityHue(candidate.sessionId)})`,
          description: `${workspaceNameFromCwd(candidate.workspace.hostCwd) ?? ''} · ${presentSessionStatus(candidate.state, locale).label}`,
        }))}>
        <footer className="maka-interaction-actions workhub-selection-actions">
          <Button variant="ghost" label={copy.explain} isDisabled={props.submitting} onClick={props.onDismiss} />
          <Button variant="ghost" label={copy.create} isDisabled={props.submitting} onClick={() => props.onChoose({ requestId: props.request.requestId, kind: 'create_new' })} />
          <Button variant="primary" label={props.submitting ? copy.submitting : copy.confirm} isDisabled={!value || props.submitting} onClick={confirm} />
        </footer>
      </ChoicePanel>
    </div>
  </section>;
}
