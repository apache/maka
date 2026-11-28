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

import { signal, Text, token, View } from 'nsh';
import { Button, Input } from 'nsh/base';
import type { InteractionAnswer } from '../../../../../packages/plugin-sdk/src/generated/runtime';
import type { AgentQuestionItem } from '../bridge';
import { formatCount, tr } from '../locale';
import { hapticImpact } from '../state/preferences';
import { spacing, type } from '../theme/tokens';
import { ActionButton } from './ActionButton';
import { Icon } from './Icon';
import { GroupDivider } from './InsetGroup';

type QuestionAnswer = Extract<InteractionAnswer, { kind: 'question' }>;

export function questionDraft() {
  const answers = signal<Record<number, string>>({});
  return {
    answers,
    set(index: number, value: string) {
      answers.update((previous) => ({ ...previous, [index]: value }));
    },
    answer(count: number): QuestionAnswer {
      const values = answers();
      return {
        kind: 'question',
        answers: Array.from({ length: count }, (_, index) => values[index]?.trim() || null),
      };
    },
  };
}

export function QuestionFields(props: {
  questions: AgentQuestionItem[];
  busy: boolean;
  draft: ReturnType<typeof questionDraft>;
  surface?: 'grouped';
}) {
  const grouped = () => props.surface === 'grouped';
  return (
    <View style={{ paddingHorizontal: grouped() ? spacing.pageX : 0, gap: 12 }}>
      <Each of={props.questions} key={(_, index) => index}>
        {(question, index) => (
          <View
            testID="question-fields"
            style={{
              backgroundColor: token(grouped() ? 'surface' : 'inline-card'),
              borderRadius: spacing.groupRadius,
              borderCurve: 'continuous',
              overflow: 'hidden',
            }}
          >
            <View style={{ padding: spacing.pageX, gap: 4 }}>
              <If when={props.questions.length > 1}>
                <Text style={{ ...type.caption, color: token('glass-muted') }}>
                  {formatCount(index() + 1) + ' / ' + formatCount(props.questions.length)}
                </Text>
              </If>
              <Text role="header" style={{ ...type.headline, color: token('foreground') }}>
                {question().question}
              </Text>
            </View>
            <View style={{ backgroundColor: token(grouped() ? 'surface' : 'inline-command') }}>
              <Each of={question().options} key={(option) => option.label}>
                {(option) => (
                  <>
                    <GroupDivider inset={spacing.pageX} />
                    <Button
                      accessibilityLabel={option().label}
                      accessibilityHint={option().description}
                      selected={props.draft.answers()[index()] === option().label}
                      disabled={props.busy}
                      onPress={() => {
                        hapticImpact('light');
                        props.draft.set(index(), option().label);
                      }}
                      class="active:bg-row-pressed disabled:opacity-45"
                      style={{
                        flexDirection: 'row',
                        alignItems: 'center',
                        gap: 12,
                        paddingHorizontal: spacing.pageX,
                        paddingVertical: 10,
                        minHeight: spacing.rowMinHeight,
                      }}
                    >
                      <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
                        <Text style={{ ...type.body, color: token('foreground') }}>
                          {option().label}
                        </Text>
                        <If when={option().description}>
                          <Text style={{ ...type.footnote, color: token('glass-muted') }}>
                            {option().description}
                          </Text>
                        </If>
                      </View>
                      <View style={{ width: 18 }}>
                        <If when={props.draft.answers()[index()] === option().label}>
                          <Icon name="check" color={token('glass-accent')} size={18} />
                        </If>
                      </View>
                    </Button>
                  </>
                )}
              </Each>
            </View>
            <GroupDivider inset={spacing.pageX} />
            <View style={{ paddingHorizontal: spacing.pageX, paddingVertical: 12, gap: 6 }}>
              <Text style={{ ...type.footnote, color: token('glass-muted') }}>
                {tr('Write your own answer')}
              </Text>
              <Input
                accessibilityLabel={tr('Write your own answer')}
                value={props.draft.answers()[index()] ?? ''}
                multiline
                disabled={props.busy}
                onChange={({ value }) => props.draft.set(index(), value)}
                style={{
                  ...type.body,
                  minHeight: spacing.rowMinHeight,
                  color: token('foreground'),
                  backgroundColor: token(grouped() ? 'grouped-bg' : 'inline-command'),
                  borderRadius: 8,
                  paddingHorizontal: 10,
                  paddingVertical: 6,
                }}
              />
            </View>
          </View>
        )}
      </Each>
    </View>
  );
}

export function QuestionForm(props: {
  questions: AgentQuestionItem[];
  busy: boolean;
  submit: (answer: QuestionAnswer) => void;
}) {
  const draft = questionDraft();
  return (
    <View style={{ gap: 12 }}>
      <QuestionFields questions={props.questions} busy={props.busy} draft={draft} />
      <ActionButton
        title={tr('Submit Answer')}
        variant="glassPrimary"
        disabled={props.busy}
        onPress={() => props.submit(draft.answer(props.questions.length))}
      />
    </View>
  );
}
