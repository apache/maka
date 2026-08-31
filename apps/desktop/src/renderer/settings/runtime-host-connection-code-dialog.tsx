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
import { Button, FormLayout, TextArea, useToast, useUiLocale } from '@maka/ui';
import { getSettingsProjectsCopy } from '../locales/settings-projects-copy.js';
import { settingsActionErrorMessage } from './settings-error-copy.js';

type RuntimeHostConnectionCodeDialogProps = {
  readonly onClose: () => void;
} & (
  | { readonly mode: 'share'; readonly connectionCode: string }
  | { readonly mode: 'import'; readonly onImported: (profileId: string) => void }
);

export function RuntimeHostConnectionCodeDialog(props: RuntimeHostConnectionCodeDialogProps) {
  const locale = useUiLocale();
  const copy = getSettingsProjectsCopy(locale).runtimeHost;
  const toast = useToast();
  const [draft, setDraft] = useState('');
  const [working, setWorking] = useState(false);

  const value = props.mode === 'share' ? props.connectionCode : draft;

  async function copyCode(): Promise<void> {
    try {
      await navigator.clipboard.writeText(value);
      toast.success(copy.connectionCodeCopied);
    } catch (error) {
      toast.error(copy.remoteAccessFailed, settingsActionErrorMessage(error, locale));
    }
  }

  async function connect(): Promise<void> {
    if (props.mode !== 'import') return;
    setWorking(true);
    try {
      const result = await window.maka.runtimeHostProfiles.importConnectionCode(draft.trim());
      if (result.kind === 'error') {
        toast.error(copy.remoteAccessFailed, connectionCodeError(copy, result.reason));
        return;
      }
      props.onImported(result.profileId);
      props.onClose();
    } catch (error) {
      toast.error(copy.remoteAccessFailed, settingsActionErrorMessage(error, locale));
    } finally {
      setWorking(false);
    }
  }

  return (
    <Dialog
      isOpen
      onOpenChange={(open) => {
        if (!open && !working) props.onClose();
      }}
      purpose="form"
      width={520}
    >
      <Layout
        header={(
          <DialogHeader
            title={
              props.mode === 'share'
                ? copy.connectionCodeTitle
                : copy.importConnectionCodeTitle
            }
            subtitle={
              props.mode === 'share'
                ? copy.connectionCodeDescription
                : copy.importConnectionCodeDescription
            }
            onOpenChange={(open) => {
              if (!open && !working) props.onClose();
            }}
          />
        )}
        content={(
          <LayoutContent padding={4}>
            <FormLayout>
              <TextArea
                label={copy.connectionCode}
                value={value}
                rows={6}
                hasSpellCheck={false}
                isDisabled={working}
                isReadOnly={props.mode === 'share'}
                onChange={props.mode === 'import' ? setDraft : () => undefined}
              />
            </FormLayout>
          </LayoutContent>
        )}
        footer={(
          <LayoutFooter>
            <Button
              variant="secondary"
              label={copy.cancel}
              isDisabled={working}
              onClick={props.onClose}
            />
            <Button
              variant="primary"
              label={
                props.mode === 'share' ? copy.copyConnectionCode : copy.connectWithCode
              }
              isDisabled={working || value.trim().length === 0}
              onClick={() => void (props.mode === 'share' ? copyCode() : connect())}
            />
          </LayoutFooter>
        )}
      />
    </Dialog>
  );
}

function connectionCodeError(
  copy: ReturnType<typeof getSettingsProjectsCopy>['runtimeHost'],
  reason: 'invalid_code' | 'code_unavailable' | 'host_unreachable' | 'host_mismatch' | 'unknown',
): string {
  switch (reason) {
    case 'invalid_code':
      return copy.connectionCodeInvalid;
    case 'code_unavailable':
      return copy.connectionCodeUnavailable;
    case 'host_unreachable':
      return copy.connectionCodeHostUnreachable;
    case 'host_mismatch':
      return copy.connectionCodeHostMismatch;
    case 'unknown':
      return copy.connectionCodeUnknownError;
  }
}
