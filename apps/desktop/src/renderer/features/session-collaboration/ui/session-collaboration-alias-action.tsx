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
import { Dialog, DialogHeader } from '@astryxdesign/core/Dialog';
import { Layout, LayoutContent, LayoutFooter } from '@astryxdesign/core/Layout';
import { Button, TextInput, useToast, useUiLocale } from '@maka/ui';
import { getSessionCollaborationCopy } from '../../../locales/session-collaboration-copy.js';
import { useSessionCollaborationServices } from '../services-context.js';

export function SessionGuestAliasAction(props: {
  readonly sessionId: string;
  readonly principalId: string;
  readonly displayName?: string;
  readonly disabled: boolean;
  readonly onChanged: () => Promise<void>;
}) {
  const services = useSessionCollaborationServices();
  return <SessionCollaborationAliasAction name={props.displayName ?? ''} disabled={props.disabled}
    onSave={async (name) => {
      await services.renamePrincipal(props.sessionId, props.principalId, name);
      await props.onChanged();
    }} />;
}

export function SessionCollaborationAliasAction(props: {
  readonly name: string;
  readonly disabled: boolean;
  readonly onSave: (name: string) => Promise<void>;
}) {
  const copy = getSessionCollaborationCopy(useUiLocale());
  const toast = useToast();
  const [name, setName] = useState<string>();
  const [saving, setSaving] = useState(false);
  async function save() {
    if (name === undefined || !name.trim() || saving) return;
    setSaving(true);
    try {
      await props.onSave(name.trim());
      setName(undefined);
    } catch (error) {
      toast.error(copy.saveAlias, error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  }
  return <>
    <Button variant="secondary" size="sm" label={copy.alias} isDisabled={props.disabled}
      onClick={() => setName(props.name)} />
    {name !== undefined ? <Dialog isOpen purpose="form" width={400}
      onOpenChange={(open) => { if (!open && !saving) setName(undefined); }}>
      <Layout header={<DialogHeader title={copy.alias} />}
        content={<LayoutContent><TextInput label={copy.alias} value={name} isDisabled={saving}
          onChange={setName} /></LayoutContent>}
        footer={<LayoutFooter>
          <Button variant="secondary" label={copy.close} isDisabled={saving}
            onClick={() => setName(undefined)} />
          <Button variant="primary" label={copy.saveAlias} isDisabled={saving || !name.trim()}
            isLoading={saving} onClick={() => void save()} />
        </LayoutFooter>} />
    </Dialog> : null}
  </>;
}
