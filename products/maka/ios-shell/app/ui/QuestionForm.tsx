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

import { signal, View, token } from 'nsh';
import type { InteractionAnswer } from '../../../../../packages/plugin-sdk/src/generated/runtime';
import type { AgentQuestionItem } from '../bridge';
import { tr } from '../locale';
import { ActionButton, GroupRow, Icon, InsetGroup } from './index';
import { SettingField } from '../screens/settings/SettingsForm';

export function QuestionForm(props: {
  questions: AgentQuestionItem[];
  busy: boolean;
  submit: (answer: Extract<InteractionAnswer, { kind: 'question' }>) => void;
}) {
  const answers = signal<Record<number, string>>({});
  function set(index: number, value: string) {
    answers.update((previous) => ({ ...previous, [index]: value }));
  }
  return (
    <View>
      <Each of={props.questions} key={(_, index) => index}>
        {(question, index) => (
          <InsetGroup header={question().question}>
            <Each of={question().options} key={(option) => option.label}>
              {(option) => (
                <GroupRow
                  title={option().label}
                  subtitle={option().description}
                  divider
                  disabled={props.busy}
                  trailing={
                    answers()[index()] === option().label ? (
                      <Icon name="check" color={token('primary')} size={18} />
                    ) : undefined
                  }
                  onPress={() => set(index(), option().label)}
                />
              )}
            </Each>
            <SettingField
              label={tr('Write your own answer')}
              value={answers()[index()] ?? ''}
              edit={(value) => set(index(), value)}
              disabled={props.busy}
            />
          </InsetGroup>
        )}
      </Each>
      <View style={{ paddingHorizontal: 16 }}>
        <ActionButton
          title={tr('Submit Answer')}
          disabled={props.busy}
          onPress={() =>
            props.submit({
              kind: 'question',
              answers: props.questions.map((_, index) => answers()[index]?.trim() || null),
            })
          }
        />
      </View>
    </View>
  );
}
