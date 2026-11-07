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

import { inputAction } from 'nsh';
import type { GeneralAction, GeneralSettingsOwner, PredictionEdit } from './generalSettingsState';
import { tr } from './locale';
import {
  SettingsBody,
  SettingsButton,
  SettingsFormFooter,
  SettingsInput,
  SettingsLede,
  SettingsSection,
  SettingsSelect,
  SettingsSwitch,
  SettingsTextArea,
} from './SettingsPage';

export function PredictionSettings(props: { owner: GeneralSettingsOwner; request: GeneralAction }) {
  const owner = props.owner;
  const request = props.request;
  const form = owner.predictionEditor;
  const edit = (change: PredictionEdit) => owner.editPrediction(request, change);
  return (
    <SettingsBody
      footer={
        <SettingsFormFooter
          saveLabel={tr('Save prediction settings')}
          canSave={!owner.disabled() && owner.dirty()}
          busy={owner.busy()}
          save={inputAction(owner.save, request)}
          cancel={inputAction(owner.cancel, request)}
          extra={
            <SettingsButton
              label={tr('Restore prediction defaults')}
              tone="quiet"
              disabled={owner.disabled()}
              onPress={inputAction(owner.restorePredictions, request)}
            />
          }
        />
      }
    >
      <SettingsLede>
        {tr(
          'Predictions appear in an empty message box. Accepting one fills in a draft; it never sends a message.',
        )}
      </SettingsLede>
      <SettingsSection note={tr('Uses the current conversation’s model and reasoning effort.')}>
        <SettingsSwitch
          label={tr('Show predictions')}
          checked={form()?.enabled ?? false}
          disabled={owner.disabled()}
          onPress={() => edit({ field: 'enabled', value: !form()?.enabled })}
        />
        <SettingsSwitch
          label={tr('Only for regular conversations')}
          checked={form()?.ordinarySessionsOnly ?? false}
          disabled={owner.disabled()}
          onPress={() =>
            edit({ field: 'ordinarySessionsOnly', value: !form()?.ordinarySessionsOnly })
          }
        />
      </SettingsSection>
      <SettingsSection
        title={tr('How often to generate a prediction.')}
        note={tr('Enter a percentage from 0 to 100.')}
      >
        <SettingsInput
          label={tr('After a reply')}
          value={form()?.liveSamplePercent ?? ''}
          placeholder="%"
          disabled={owner.disabled()}
          change={(value) => edit({ field: 'liveSamplePercent', value })}
        />
        <SettingsInput
          label={tr('When opening a conversation')}
          value={form()?.catchUpSamplePercent ?? ''}
          placeholder="%"
          disabled={owner.disabled()}
          change={(value) => edit({ field: 'catchUpSamplePercent', value })}
        />
      </SettingsSection>
      <SettingsSection
        title={tr('Prediction instructions')}
        note={
          form()?.useDefault
            ? tr(
                'Built-in instructions follow the interface language. Suggestions match the conversation.',
              )
            : tr('Your instructions replace the built-in instructions for every conversation.')
        }
      >
        <SettingsSelect
          label={tr('Prediction instruction source')}
          value={form()?.useDefault ? 'default' : 'custom'}
          choices={[
            { value: 'default', title: tr('Built-in instructions') },
            { value: 'custom', title: tr('Custom instructions') },
          ]}
          disabled={owner.disabled()}
          change={(value) =>
            value === 'default'
              ? owner.restorePredictionPrompt(request)
              : edit({ field: 'prompt', value: form()?.prompt ?? '' })
          }
        />
        <SettingsTextArea
          label={tr('Prediction instructions')}
          value={form()?.prompt ?? ''}
          lines={10}
          readonly={form()?.useDefault}
          disabled={owner.disabled()}
          change={(value) => edit({ field: 'prompt', value })}
        />
      </SettingsSection>
    </SettingsBody>
  );
}
