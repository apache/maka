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

import { inputAction, Text, View, windowSize, type JSX } from 'nsh';
import {
  Button,
  Input,
  Select,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from 'nsh/base';
import { ChoiceIndicator } from './ChoiceIndicator';
import { Icon } from './Icon';
import { SettingsEditor } from './SettingsField';
import type { GeneralAction, GeneralSettingsOwner, PredictionEdit } from './generalSettingsState';
import { tr } from './locale';
import {
  bodyTextStyle,
  captionTextStyle,
  controlDisabledStyle,
  controlFocusStyle,
  controlHoverStyle,
  controlStyle,
  inputBorderRadius,
  inputTextStyle,
  C,
} from './ui';

export function PredictionPreferences(props: {
  owner: GeneralSettingsOwner;
  request: GeneralAction;
}) {
  const owner = props.owner;
  const enabled = () => owner.facts()?.predictions.enabled ?? false;
  return (
    <View style={{ gap: 4 }}>
      <Button
        selected={enabled()}
        disabled={owner.disabled()}
        accessibilityLabel={tr('{label}: {state}', {
          label: tr('Message predictions'),
          state: enabled() ? tr('On') : tr('Off'),
        })}
        onPress={inputAction(owner.toggle, { request: props.request, kind: 'predictions' })}
        style={{ ...controlStyle, flexDirection: 'row', alignItems: 'center', gap: 12 }}
        hoverStyle={controlHoverStyle()}
        focusStyle={controlFocusStyle()}
        disabledStyle={controlDisabledStyle}
      >
        <View style={{ flex: 1, minWidth: 0, gap: 4, pointerEvents: 'none' }}>
          <Text style={{ ...bodyTextStyle, color: C.text }}>{tr('Message predictions')}</Text>
          <Text style={{ ...captionTextStyle, color: C.muted }}>
            {tr('Suggest your next message from the conversation.')}
          </Text>
        </View>
        <ChoiceIndicator kind="switch" checked={enabled()} disabled={owner.disabled()} />
      </Button>
      <Button
        disabled={owner.disabled()}
        accessibilityLabel={tr('Configure message predictions')}
        onPress={inputAction(owner.open, { request: props.request, kind: 'predictions' })}
        style={{ ...controlStyle, flexDirection: 'row', alignItems: 'center', gap: 12 }}
        hoverStyle={controlHoverStyle()}
        focusStyle={controlFocusStyle()}
        disabledStyle={controlDisabledStyle}
      >
        <Text style={{ ...bodyTextStyle, color: C.secondary, flex: 1 }}>
          {tr('Prediction settings…')}
        </Text>
        <Icon name="right" color={C.muted} />
      </Button>
    </View>
  );
}

type Choice = { value: string; title: string; disabled?: boolean; group?: string };
const fieldStyle = () => ({
  ...inputTextStyle,
  height: 32,
  paddingHorizontal: 12,
  paddingVertical: 4,
  borderWidth: 1,
  borderColor: C.line,
  borderRadius: inputBorderRadius,
  backgroundColor: C.background,
  color: C.text,
});

function PredictionChoice(props: {
  label: string;
  value: string;
  choices: Choice[];
  disabled: boolean;
  change(value: string): void;
}) {
  return (
    <Select
      items={props.choices}
      value={props.value}
      onChange={({ value }) => {
        if (value !== null) props.change(value);
      }}
      accessibilityLabel={props.label}
      disabled={props.disabled}
      offset={4}
      margin={8}
      align="end"
      popupStyle={{
        width: 320,
        maxWidth: Math.max(0, windowSize().width - 16),
        maxHeight: Math.min(360, Math.max(0, windowSize().height - 16)),
        minHeight: 0,
        padding: 8,
        backgroundColor: C.surface,
        borderWidth: 1,
        borderColor: C.line,
        borderRadius: 12,
      }}
      groupStyle={{ paddingHorizontal: 12, paddingTop: 12, paddingBottom: 4 }}
      style={{ width: '100%', minWidth: 0 }}
      trigger={
        <View
          style={{
            ...controlStyle,
            flexDirection: 'row',
            alignItems: 'center',
            gap: 8,
            minWidth: 0,
            borderWidth: 1,
            borderColor: C.line,
          }}
          hoverStyle={controlHoverStyle()}
          focusStyle={controlFocusStyle()}
          disabledStyle={controlDisabledStyle}
        >
          <Text
            style={{ ...captionTextStyle, color: C.text, flex: 1, minWidth: 0, numberOfLines: 1 }}
          >
            {props.choices.find((choice) => choice.value === props.value)?.title ?? props.value}
          </Text>
          <Icon name="down" color={C.muted} />
        </View>
      }
      itemClass={`rounded-lg focus:bg-[${C.raised}]`}
      renderItem={(item) => (
        <View
          style={{
            ...controlStyle,
            minHeight: 32,
            flexDirection: 'row',
            alignItems: 'center',
            gap: 8,
          }}
        >
          <Text style={{ ...captionTextStyle, color: item.disabled ? C.muted : C.text, flex: 1 }}>
            {item.title}
          </Text>
          <ChoiceIndicator
            kind="radio"
            checked={item.value === props.value}
            disabled={item.disabled}
          />
        </View>
      )}
    />
  );
}

function PredictionRow(props: { label: string; hint?: string; children: JSX.Element }) {
  return (
    <TableRow style={{ borderBottomWidth: 1, borderColor: C.line }}>
      <TableCell
        style={{ width: '36%', minWidth: 0, paddingVertical: 12, paddingRight: 16, gap: 4 }}
      >
        <Text style={{ ...bodyTextStyle, color: C.text }}>{props.label}</Text>
        <If when={props.hint}>
          <Text style={{ ...captionTextStyle, color: C.muted }}>{props.hint}</Text>
        </If>
      </TableCell>
      <TableCell
        style={{ flex: 1, minWidth: 0, paddingVertical: 8, gap: 8, justifyContent: 'center' }}
      >
        {props.children}
      </TableCell>
    </TableRow>
  );
}

export function PredictionSettings(props: { owner: GeneralSettingsOwner; request: GeneralAction }) {
  const owner = props.owner;
  const request = props.request;
  const form = owner.predictionEditor;
  const edit = (change: PredictionEdit) => owner.editPrediction(request, change);
  return (
    <View style={{ gap: 16 }}>
      <Text style={{ ...captionTextStyle, color: C.muted }}>
        {tr(
          'Predictions appear in an empty message box. Accepting one fills in a draft; it never sends a message.',
        )}
      </Text>
      <Text style={{ ...captionTextStyle, color: C.muted }}>
        {tr('Uses the current conversation’s model and reasoning effort.')}
      </Text>
      <Table accessibilityLabel={tr('Message prediction settings')}>
        <TableHeader>
          <TableRow style={{ borderBottomWidth: 1, borderColor: C.line }}>
            <TableHead style={{ width: '36%', paddingVertical: 8, paddingRight: 16 }}>
              <Text style={{ ...captionTextStyle, color: C.secondary, fontWeight: '500' }}>
                {tr('Setting')}
              </Text>
            </TableHead>
            <TableHead style={{ flex: 1, paddingVertical: 8 }}>
              <Text style={{ ...captionTextStyle, color: C.secondary, fontWeight: '500' }}>
                {tr('Value')}
              </Text>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <Each
            of={
              [
                { field: 'enabled', label: tr('Show predictions') },
                { field: 'ordinarySessionsOnly', label: tr('Only for regular conversations') },
              ] as const
            }
            key={(item) => item.field}
          >
            {(item) => (
              <PredictionRow label={item().label}>
                <Button
                  selected={form()?.[item().field] ?? false}
                  disabled={owner.disabled()}
                  accessibilityLabel={tr('{label}: {state}', {
                    label: item().label,
                    state: form()?.[item().field] ? tr('On') : tr('Off'),
                  })}
                  onPress={inputAction(edit, {
                    field: item().field,
                    value: !form()?.[item().field],
                  })}
                  style={{
                    ...controlStyle,
                    alignSelf: 'flex-start',
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 8,
                  }}
                  hoverStyle={controlHoverStyle()}
                  focusStyle={controlFocusStyle()}
                  disabledStyle={controlDisabledStyle}
                >
                  <ChoiceIndicator
                    kind="switch"
                    checked={form()?.[item().field] ?? false}
                    disabled={owner.disabled()}
                  />
                  <Text style={{ ...captionTextStyle, color: C.text }}>
                    {form()?.[item().field] ? tr('On') : tr('Off')}
                  </Text>
                </Button>
              </PredictionRow>
            )}
          </Each>
          <Each
            of={
              [
                { field: 'liveSamplePercent', label: tr('After a reply') },
                { field: 'catchUpSamplePercent', label: tr('When opening a conversation') },
              ] as const
            }
            key={(item) => item.field}
          >
            {(item) => (
              <PredictionRow label={item().label} hint={tr('How often to generate a prediction.')}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                  <Input
                    accessibilityLabel={item().label}
                    value={form()?.[item().field] ?? ''}
                    onChange={({ value }) => edit({ field: item().field, value })}
                    readonly={owner.disabled()}
                    autoCapitalize="none"
                    autoCorrect={false}
                    style={{ ...fieldStyle(), width: 80 }}
                    focusStyle={{ borderColor: C.accent }}
                  />
                  <Text style={{ ...captionTextStyle, color: C.secondary }}>%</Text>
                </View>
              </PredictionRow>
            )}
          </Each>
          <PredictionRow label={tr('Prediction instructions')}>
            <PredictionChoice
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
            <Text style={{ ...captionTextStyle, color: C.muted }}>
              {form()?.useDefault
                ? tr(
                    'Built-in instructions follow the interface language. Suggestions match the conversation.',
                  )
                : tr('Your instructions replace the built-in instructions for every conversation.')}
            </Text>
            <View style={{ height: 240, minHeight: 0 }}>
              <SettingsEditor
                label={tr('Prediction instructions')}
                value={form()?.prompt ?? ''}
                change={(value) => edit({ field: 'prompt', value })}
                readonly={form()?.useDefault}
                disabled={owner.disabled()}
              />
            </View>
          </PredictionRow>
        </TableBody>
      </Table>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        <Button
          disabled={owner.disabled() || !owner.dirty()}
          onPress={inputAction(owner.save, request)}
          accessibilityLabel={tr('Save prediction settings')}
          focusStyle={{ backgroundColor: C.accentHover }}
          style={{ ...controlStyle, backgroundColor: C.accent }}
          hoverStyle={{ backgroundColor: C.accentHover }}
          disabledStyle={controlDisabledStyle}
        >
          <Text style={{ ...bodyTextStyle, color: C.background, fontWeight: '500' }}>
            {tr('Save')}
          </Text>
        </Button>
        <Button
          disabled={owner.busy()}
          accessibilityLabel={tr('Cancel')}
          onPress={inputAction(owner.cancel, request)}
          style={controlStyle}
          hoverStyle={controlHoverStyle()}
          focusStyle={controlFocusStyle()}
          disabledStyle={controlDisabledStyle}
        >
          <Text style={{ ...bodyTextStyle, color: C.secondary }}>{tr('Cancel')}</Text>
        </Button>
        <Button
          disabled={owner.disabled()}
          accessibilityLabel={tr('Restore prediction defaults')}
          onPress={inputAction(owner.restorePredictions, request)}
          style={controlStyle}
          hoverStyle={controlHoverStyle()}
          focusStyle={controlFocusStyle()}
          disabledStyle={controlDisabledStyle}
        >
          <Text style={{ ...bodyTextStyle, color: C.secondary }}>
            {tr('Restore prediction defaults')}
          </Text>
        </Button>
      </View>
    </View>
  );
}
