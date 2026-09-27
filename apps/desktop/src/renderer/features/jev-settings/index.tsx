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

import { useState } from 'react';
import { Collapsible } from '@astryxdesign/core/Collapsible';
import { JEV_COPY } from '../../locales/settings-jev-copy.js';
import {
  SettingsActions,
  SettingsField,
  SettingsRow,
  SettingsSection,
  useActionGuard,
} from '../../application/contracts/settings-presentation/index.js';
import type { AppSettings, UpdateAppSettingsInput, UpdateAppSettingsResult } from '@maka/core/settings';
import { Button, Switch, TextInput, useMountedRef, useToast, useUiLocale } from '@maka/ui';

export function JevSettingsSection(props: {
  settings: AppSettings['jev'];
  isInteractive: boolean;
  onUpdate(patch: UpdateAppSettingsInput): Promise<UpdateAppSettingsResult>;
}) {
  const { settings, isInteractive } = props;
  const locale = useUiLocale();
  const copy = JEV_COPY[locale];
  const [key, setKey] = useState('');
  const [saving, setSaving] = useState(false);
  const guard = useActionGuard<'save'>();
  const mounted = useMountedRef();
  const toast = useToast();
  async function save(patch: Partial<AppSettings['jev']>) {
    if (!isInteractive || !guard.begin('save')) return;
    setSaving(true);
    try {
      await props.onUpdate({ jev: patch });
      if (mounted.current && patch.apiKey !== undefined) setKey('');
    } catch {
      if (mounted.current) toast.error(copy.failure);
    } finally {
      guard.finish();
      if (mounted.current) setSaving(false);
    }
  }
  return (
    <Collapsible trigger={copy.advanced} defaultIsOpen={false}>
      <SettingsSection>
        <SettingsRow label={copy.title} description={copy.help} align="start" end={(
          <Switch label={copy.title} isLabelHidden value={settings.enabled}
            isDisabled={!isInteractive || saving || !settings.apiKey}
            onChange={(enabled) => void save({ enabled })} />
        )} />
        <SettingsField>
          <TextInput label={copy.key} type="password" value={key}
            placeholder={settings.apiKey ? copy.saved : 'TypeSafe API Key'}
            description={copy.behavior} isDisabled={!isInteractive || saving}
            width="100%" onChange={setKey} />
        </SettingsField>
        <SettingsActions>
          <Button label={saving ? copy.saving : copy.save} variant="secondary"
            isDisabled={!isInteractive || saving || !key.trim()} onClick={() => void save({ apiKey: key.trim() })} />
          {settings.apiKey && <Button label={copy.clear} variant="secondary"
            isDisabled={!isInteractive || saving} onClick={() => void save({ apiKey: '', enabled: false })} />}
        </SettingsActions>
      </SettingsSection>
    </Collapsible>
  );
}
