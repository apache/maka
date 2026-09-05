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

import { Button } from '@maka/ui';
import { SettingsField, SettingsSection } from './settings-section';
import type { MemorySettingsCopy } from '../locales/settings-memory-copy';

export function MemoryPromptPreviewSection(props: {
  copy: MemorySettingsCopy;
  active: boolean;
  preview: string;
  budgetLabel: string;
  blockedReason: string;
  safeMode: boolean;
  copyPending: boolean;
  onCopy(): void | Promise<void>;
}) {
  return (
    <SettingsSection
      title={props.copy.text.promptPreview}
      description={props.copy.text.promptPreviewHelp}
      action={(
        <div className="settingsFormRowControlCluster">
          <span className="settingsMemoryInjectState" data-active={props.active ? 'true' : 'false'}>
            {props.active ? props.copy.text.willInject : props.copy.text.willNotInject}
          </span>
          <Button
            variant="ghost"
            size="sm"
            isDisabled={!props.preview || props.copyPending}
            onClick={() => void props.onCopy()}
            label={props.copyPending ? props.copy.text.copying : props.copy.text.copyContext}
          />
        </div>
      )}
    >
      <SettingsField className="settingsMemoryPromptPreview">
        <small className="settingsMemoryPromptPreviewBudget">{props.budgetLabel}</small>
        {props.preview ? (
          <pre>{props.preview}</pre>
        ) : (
          <p>{props.safeMode ? props.copy.text.safeModePreview : props.copy.text.emptyPromptPreview}</p>
        )}
        {props.blockedReason && props.preview && <small>{props.blockedReason}</small>}
      </SettingsField>
    </SettingsSection>
  );
}
