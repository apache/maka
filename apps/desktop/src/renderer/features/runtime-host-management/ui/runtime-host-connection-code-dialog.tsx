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
import { Tooltip } from '@astryxdesign/core/Tooltip';
import { Button, FormLayout, IconButton, TextArea, useToast } from '@maka/ui';
import { HelpCircle, ICON_SIZE } from '@maka/ui/icons';
import { useRuntimeHostManagementServices } from '../services-context.js';
import type { RuntimeHostConnectionCodeImportResult } from '../ports.js';

export interface RuntimeHostConnectionCodeCopy {
  readonly cancel: string;
  readonly remoteAccessFailed: string;
  readonly connectionCodeTitle: string;
  readonly connectionCodeDescription: string;
  readonly importConnectionCodeTitle: string;
  readonly importConnectionCodeDescription: string;
  readonly connectionCodeHelpLabel: string;
  readonly connectionCodeHelp: string;
  readonly connectionCode: string;
  readonly copyConnectionCode: string;
  readonly pasteConnectionCode: string;
  readonly connectionCodeCopied: string;
  readonly connectionCodeInvalid: string;
  readonly connectionCodeUnavailable: string;
  readonly connectionCodeHostUnreachable: string;
  readonly connectionCodeHostMismatch: string;
  readonly connectionCodeUnknownError: string;
  readonly connectWithCode: string;
}

type RuntimeHostConnectionCodeDialogProps = {
  readonly copy: RuntimeHostConnectionCodeCopy;
  readonly errorMessage: (error: unknown) => string;
  readonly onClose: () => void;
} & (
  | { readonly mode: 'share'; readonly connectionCode: string }
  | { readonly mode: 'import'; readonly onImported: (profileId: string) => void }
);

export function RuntimeHostConnectionCodeDialog(props: RuntimeHostConnectionCodeDialogProps) {
  const services = useRuntimeHostManagementServices().connectionCodes;
  const toast = useToast();
  const [draft, setDraft] = useState('');
  const [working, setWorking] = useState(false);
  const value = props.mode === 'share' ? props.connectionCode : draft;

  async function copyCode(): Promise<void> {
    try {
      await services.writeClipboardText(value);
      toast.success(props.copy.connectionCodeCopied);
    } catch (error) {
      toast.error(props.copy.remoteAccessFailed, props.errorMessage(error));
    }
  }

  async function pasteCode(): Promise<void> {
    try {
      setDraft(await services.readClipboardText());
    } catch (error) {
      toast.error(props.copy.remoteAccessFailed, props.errorMessage(error));
    }
  }

  async function connect(): Promise<void> {
    if (props.mode !== 'import') return;
    setWorking(true);
    try {
      const result = await services.importCode(draft.trim());
      if (result.kind === 'error') {
        toast.error(
          props.copy.remoteAccessFailed,
          connectionCodeError(props.copy, result.reason),
        );
        return;
      }
      props.onImported(result.profileId);
      props.onClose();
    } catch (error) {
      toast.error(props.copy.remoteAccessFailed, props.errorMessage(error));
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
                ? props.copy.connectionCodeTitle
                : props.copy.importConnectionCodeTitle
            }
            subtitle={
              props.mode === 'share'
                ? props.copy.connectionCodeDescription
                : props.copy.importConnectionCodeDescription
            }
            endContent={props.mode === 'import' ? (
              <Tooltip content={props.copy.connectionCodeHelp}>
                <IconButton
                  label={props.copy.connectionCodeHelpLabel}
                  icon={<HelpCircle size={ICON_SIZE.control} aria-hidden="true" />}
                  variant="ghost"
                  size="sm"
                />
              </Tooltip>
            ) : undefined}
            onOpenChange={(open) => {
              if (!open && !working) props.onClose();
            }}
          />
        )}
        content={(
          <LayoutContent padding={4}>
            <FormLayout>
              <TextArea
                label={props.copy.connectionCode}
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
              label={props.copy.cancel}
              isDisabled={working}
              onClick={props.onClose}
            />
            {props.mode === 'import' ? (
              <Button
                variant="secondary"
                label={props.copy.pasteConnectionCode}
                isDisabled={working}
                onClick={() => void pasteCode()}
              />
            ) : null}
            <Button
              variant="primary"
              label={
                props.mode === 'share'
                  ? props.copy.copyConnectionCode
                  : props.copy.connectWithCode
              }
              isDisabled={working || value.trim().length === 0}
              isLoading={props.mode === 'import' && working}
              onClick={() => void (props.mode === 'share' ? copyCode() : connect())}
            />
          </LayoutFooter>
        )}
      />
    </Dialog>
  );
}

function connectionCodeError(
  copy: RuntimeHostConnectionCodeCopy,
  reason: Extract<RuntimeHostConnectionCodeImportResult, { kind: 'error' }>['reason'],
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
