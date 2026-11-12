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

import { signal, type JSX, type Signal } from 'nsh';
import {
  SettingsBody,
  SettingsButton,
  SettingsProblem,
  SettingsRow,
  SettingsSection,
  SettingsSegmented,
} from '../../../products/maka/workbench/app/SettingsPage';
import { tr } from '../../../products/maka/workbench/app/locale';
import { errorText, renderText } from '../../../products/maka/workbench/app/text';
import { LIMITS, type HistoryEntry, type Limit } from './history';

export type History = {
  entries: Signal<readonly HistoryEntry[]>;
  limit: Signal<Limit>;
  failure: Signal<unknown>;
  setLimit(limit: Limit): void;
  clear(): void;
};

export function HistorySettings(props: { history: History }): JSX.Element {
  const { history } = props;
  const armed = signal(false);
  return (
    <SettingsBody>
      <If when={history.failure() !== null}>
        <SettingsProblem message={renderText(errorText(history.failure()))} />
      </If>
      <SettingsSection
        note={tr(
          'Kept in memory only and gone when Maka quits. Copies from password managers are skipped.',
        )}
      >
        <SettingsSegmented
          label={tr('Entries kept')}
          value={String(history.limit())}
          choices={LIMITS.map((limit) => ({ value: String(limit), title: String(limit) }))}
          change={(value) => history.setLimit(Number(value) as Limit)}
        />
        <SettingsRow
          label={tr('Clear history')}
          description={tr('{count} entries', { count: history.entries().length })}
          trailing={
            <SettingsButton
              label={armed() ? tr('Confirm clear') : tr('Clear')}
              tone={armed() ? 'danger' : undefined}
              disabled={history.entries().length === 0}
              onPress={() => {
                if (!armed()) return armed.set(true);
                armed.set(false);
                history.clear();
              }}
            />
          }
        />
      </SettingsSection>
    </SettingsBody>
  );
}
