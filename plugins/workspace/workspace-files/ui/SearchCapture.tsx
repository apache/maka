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

import { Text, View } from 'nsh';
import type { UiToolProps } from '../../../../packages/plugin-sdk/src/workbench.js';
import { tr } from '../../../../products/maka/workbench/app/locale';
import {
  bodyTextStyle,
  captionTextStyle,
  codeTextStyle,
  C,
} from '../../../../products/maka/workbench/app/ui';

function Section(props: { label: string; text: string; warning?: boolean }) {
  return (
    <View
      style={{
        paddingHorizontal: 8,
        paddingVertical: 8,
        backgroundColor: C.background,
        borderRadius: 8,
      }}
    >
      <Text
        style={[
          { ...captionTextStyle, color: C.secondary, fontWeight: '600' },
          { userSelect: 'none' },
        ]}
      >
        {props.label}
      </Text>
      <Text
        style={[
          { ...codeTextStyle, color: props.warning ? C.warning : C.text },
          { userSelect: 'text' },
        ]}
      >
        {props.text}
      </Text>
    </View>
  );
}

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

function Literal(props: UiToolProps) {
  return (
    <Section
      label={props.field === 'arguments' ? tr('Original arguments') : tr('Original result')}
      text={
        typeof props.value === 'string'
          ? props.value
          : (JSON.stringify(props.value, null, 2) ?? String(props.value))
      }
    />
  );
}

export function SearchCapture(props: UiToolProps & { matches: 'files' | 'matches' }) {
  if (props.field === 'arguments') {
    const value = record(props.value);
    if (typeof value?.pattern !== 'string') return <Literal {...props} />;
    return <Section label={tr('Search pattern')} text={value.pattern} />;
  }
  const result = record(props.value);
  if (result?.kind === 'failed' && typeof result.message === 'string')
    return (
      <View style={{ gap: 4 }}>
        <Text style={{ ...captionTextStyle, color: C.danger }}>{tr('Tool failed')}</Text>
        <Text style={[{ ...bodyTextStyle, color: C.danger }, { userSelect: 'text' }]}>
          {result.message}
        </Text>
      </View>
    );
  const value = result?.kind === 'completed' ? record(result.value) : null;
  const matches = value?.[props.matches];
  if (
    !Array.isArray(matches) ||
    !matches.every((match) => typeof match === 'string') ||
    typeof value?.complete !== 'boolean'
  )
    return <Literal {...props} />;
  return (
    <View style={{ gap: 8, minWidth: 0 }}>
      <Section
        label={props.matches === 'files' ? tr('Matching files') : tr('Matching lines')}
        text={matches.length ? matches.join('\n') : tr('No matches.')}
      />
      <If when={!value.complete}>
        <Section
          label={tr('Search notice')}
          text={tr('The tool reported an incomplete search result.')}
          warning
        />
      </If>
    </View>
  );
}
