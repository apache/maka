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

import { keymap } from 'nsh';
import { tr } from './locale';
import { uiScale } from './uiScale';
import { SettingsRow, SettingsSelect } from './SettingsPage';

const presets = [75, 90, 100, 110, 125, 150, 200];

export function UiScaleSettings() {
  const current = () => Number(uiScale.text()) || 100;
  const choices = () =>
    [...new Set([...presets, current()])]
      .sort((a, b) => a - b)
      .map((percent) => ({ value: String(percent), title: `${percent}%` }));
  return (
    <If
      when={uiScale.supported}
      else={
        <SettingsRow
          label={tr('Interface scale')}
          description={tr('Use your terminal’s font size to scale the Unicode interface.')}
        />
      }
    >
      <SettingsSelect
        label={tr('Interface scale')}
        description={
          uiScale.error() ||
          tr('{shortcut} restores 100%.', { shortcut: keymap.label('mod+alt+0') })
        }
        value={String(current())}
        choices={choices()}
        disabled={!uiScale.ready() || uiScale.saving()}
        change={(value) => {
          if (uiScale.preview(value)) void uiScale.save();
        }}
      />
    </If>
  );
}
