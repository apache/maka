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
import type {
  AppliedPreset,
  AgentBackendPreference,
} from '../../../../packages/plugin-sdk/src/index.js';
import { tr } from './locale';
import { C, captionTextStyle } from './ui';

export function AppliedPresetDetails(props: {
  preset: AppliedPreset;
  backend?: AgentBackendPreference | null;
}) {
  return (
    <View style={{ gap: 8 }}>
      <Text style={{ ...captionTextStyle, color: C.text }}>{props.preset.name}</Text>
      <Text style={{ ...captionTextStyle, color: C.text }}>
        {tr('Initial model')}: {props.preset.model.connectionId} / {props.preset.model.modelId} ·{' '}
        {props.preset.thinkingLevel ?? tr('Default')}
      </Text>
      <Text style={{ ...captionTextStyle, color: C.text }}>
        {tr('Current model')}: {currentPresetModel(props.backend)}
      </Text>
      <Text style={{ ...captionTextStyle, color: C.muted }}>{tr('Role instruction')}</Text>
      <Text style={[{ ...captionTextStyle, color: C.text }, { userSelect: 'text' }]}>
        {props.preset.instruction}
      </Text>
    </View>
  );
}

function currentPresetModel(
  backend:
    | import('../../../../packages/plugin-sdk/src/index.js').AgentBackendPreference
    | null
    | undefined,
): string {
  if (!backend) return tr('Default');
  return backend.kind === 'model'
    ? `${backend.connectionId} / ${backend.modelId} · ${backend.thinkingLevel ?? tr('Default')}`
    : `${backend.selection.executor} / ${backend.selection.settings.model ?? tr('Default')}`;
}
