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

import { Input, Text, View } from 'nsh';
import { Button } from 'nsh/base';
import type { FormField } from '../../../../packages/plugin-sdk/src/generated/runtime';
import type { FormDraft, FormRequest as Request } from './interaction-form';
import { ChoiceIndicator } from './ChoiceIndicator';
import { tr } from './locale';
import { renderText, type UiText } from './text';
import {
  bodyTextStyle,
  C,
  captionTextStyle,
  compact,
  controlDisabledStyle,
  controlFocusStyle,
  controlHoverStyle,
  controlStyle,
  inputBorderRadius,
  inputTextStyle,
} from './ui';

type Change = Partial<FormDraft>;
function Choice(props: {
  label: string;
  selected?: boolean;
  disabled: boolean;
  onPress: () => void;
  text?: string;
  kind?: 'checkbox' | 'radio' | 'switch';
}) {
  return (
    <Button
      disabled={props.disabled}
      selected={props.selected}
      accessibilityLabel={props.label}
      onPress={props.onPress}
      style={{
        ...controlStyle,
        minWidth: 0,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'flex-start',
        gap: 8,
        backgroundColor: props.selected ? C.raised : C.surface,
      }}
      hoverStyle={controlHoverStyle}
      focusStyle={controlFocusStyle}
      disabledStyle={controlDisabledStyle}
    >
      <If when={props.kind}>
        <ChoiceIndicator kind={props.kind!} checked={!!props.selected} disabled={props.disabled} />
      </If>
      <Text style={{ ...bodyTextStyle, flexShrink: 1, color: props.disabled ? C.muted : C.text }}>
        {props.text ?? props.label}
      </Text>
    </Button>
  );
}
export function FormRequest(props: {
  request: Request;
  drafts: FormDraft[];
  problems: Array<UiText | null>;
  blocked: boolean;
  action: (index: number, change: Change) => () => void;
  edit: (index: number, original: string, value: string) => void;
}) {
  // Native edit callbacks keep the original form identity, just as presented
  // button actions do. Refreshing another request never retargets a field edit.
  const original = JSON.stringify(props.request);
  return (
    <View style={{ gap: 16 }}>
      <View style={{ gap: 4 }}>
        <Text selectable style={{ ...bodyTextStyle, color: C.secondary, fontWeight: '500' }}>
          {props.request.requester.name}
        </Text>
        <If when={props.request.requester.source}>
          <Text selectable style={{ ...captionTextStyle, color: C.muted }}>
            {props.request.requester.source}
          </Text>
        </If>
      </View>
      <Text selectable style={{ ...bodyTextStyle, color: C.text }}>
        {props.request.message}
      </Text>
      <Each<FormField> of={props.request.fields} key="index">
        {(field, index) => {
          const draft = () => props.drafts[index()];
          const disabled = () => props.blocked || !draft()?.included;
          const placeholder = () => {
            const current = field();
            return current.kind === 'string'
              ? (current.format ?? tr('Text'))
              : current.kind === 'integer'
                ? tr('Whole number')
                : tr('Number');
          };
          const options = () => {
            const current = field();
            return current.kind === 'single_select' || current.kind === 'multi_select'
              ? current.options
              : [];
          };
          return (
            <View style={{ gap: 8, paddingTop: 16, borderTopWidth: 1, borderTopColor: C.line }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
                  <Text style={{ ...bodyTextStyle, color: C.text, fontWeight: '600' }}>
                    {field().label}
                  </Text>
                  <Text style={{ ...captionTextStyle, color: C.muted }}>
                    {field().required ? tr('Required') : tr('Optional')}
                  </Text>
                </View>
                <If when={!field().required}>
                  <Choice
                    label={
                      draft()?.included
                        ? tr('Omit {label}', { label: field().label })
                        : tr('Include {label}', { label: field().label })
                    }
                    text={draft()?.included ? tr('Included') : tr('Include')}
                    kind="switch"
                    disabled={props.blocked}
                    selected={draft()?.included}
                    onPress={props.action(index(), { included: !draft()?.included })}
                  />
                </If>
              </View>
              <If when={field().description}>
                <Text selectable style={{ ...bodyTextStyle, color: C.muted }}>
                  {field().description}
                </Text>
              </If>
              <If when={draft()?.included}>
                <If when={['string', 'number', 'integer'].includes(field().kind)}>
                  <Input
                    accessibilityLabel={field().label}
                    value={String(draft()?.value ?? '')}
                    readonly={disabled()}
                    masked={draft()?.hidden}
                    autoCorrect={false}
                    placeholder={placeholder()}
                    onChange={(value) => props.edit(index(), original, value)}
                    style={{
                      ...inputTextStyle,
                      height: compact() ? 32 : 40,
                      paddingHorizontal: 12,
                      paddingVertical: compact() ? 4 : 8,
                      color: C.text,
                      backgroundColor: C.background,
                      borderRadius: inputBorderRadius,
                      borderWidth: 1,
                      borderColor: C.line,
                      placeholderColor: C.muted,
                    }}
                    focusStyle={{ borderColor: C.accent }}
                  />
                  <If when={field().kind === 'string'}>
                    <View style={{ alignItems: 'flex-end' }}>
                      <Choice
                        label={
                          draft()?.hidden
                            ? tr('Reveal {label}', { label: field().label })
                            : tr('Hide {label}', { label: field().label })
                        }
                        text={draft()?.hidden ? tr('Reveal value') : tr('Hide value')}
                        disabled={props.blocked}
                        onPress={props.action(index(), { hidden: !draft()?.hidden })}
                      />
                    </View>
                  </If>
                </If>
                <If when={field().kind === 'boolean'}>
                  <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                    <Each of={[true, false]}>
                      {(value) => (
                        <Choice
                          label={tr('{answer} · {label}', {
                            answer: value() ? tr('Yes') : tr('No'),
                            label: field().label,
                          })}
                          text={value() ? tr('Yes') : tr('No')}
                          kind="radio"
                          disabled={disabled()}
                          selected={draft()?.value === value()}
                          onPress={props.action(index(), { value: value() })}
                        />
                      )}
                    </Each>
                  </View>
                </If>
                <If when={field().kind === 'single_select' || field().kind === 'multi_select'}>
                  <Each of={options()} key="index">
                    {(option) => {
                      const selected = () =>
                        field().kind === 'multi_select'
                          ? Array.isArray(draft()?.value) &&
                            (draft().value as string[]).includes(option().value)
                          : draft()?.value === option().value;
                      const next = () =>
                        field().kind === 'multi_select'
                          ? selected()
                            ? (draft().value as string[]).filter((part) => part !== option().value)
                            : [
                                ...(Array.isArray(draft()?.value)
                                  ? (draft().value as string[])
                                  : []),
                                option().value,
                              ]
                          : option().value;
                      return (
                        <Choice
                          label={option().label}
                          kind={field().kind === 'multi_select' ? 'checkbox' : 'radio'}
                          disabled={disabled()}
                          selected={selected()}
                          onPress={props.action(index(), { value: next() })}
                        />
                      );
                    }}
                  </Each>
                </If>
                <If when={props.problems[index()]}>
                  <Text style={{ ...bodyTextStyle, color: C.warning }}>
                    {renderText(props.problems[index()]!)}
                  </Text>
                </If>
              </If>
            </View>
          );
        }}
      </Each>
    </View>
  );
}
