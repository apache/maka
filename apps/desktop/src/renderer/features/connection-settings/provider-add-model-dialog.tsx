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

import { useState, type FormEvent } from 'react';
import { isRelayProviderType, type ProviderType } from '@maka/core/llm-connections';
import { supportsRelayFastServiceTier, type ModelOverride } from '@maka/core/model-thinking';
import { CapabilityEditor } from './provider-capability-editor';
import { Dialog, DialogHeader } from '@astryxdesign/core/Dialog';
import { Layout, LayoutContent, LayoutFooter } from '@astryxdesign/core/Layout';
import { Button, HStack, TextInput, useUiLocale } from '@maka/ui';
import { getProviderSettingsCopy } from './settings-provider-copy.js';
import { parseContextWindowInput } from './context-window-input.js';

export function AddModelDialog(props: {
  isOpen: boolean;
  providerType: ProviderType;
  existingModelIds: readonly string[];
  /** Another write is in flight; the store would drop this one on the floor. */
  isSubmitDisabled?: boolean;
  onOpenChange(open: boolean): void;
  /** Resolves to whether the write landed; the draft is held until it did. */
  onSubmit(id: string, profile: ModelOverride): Promise<boolean>;
}) {
  const copy = getProviderSettingsCopy(useUiLocale()).detail;
  const [id, setId] = useState('');
  const [profile, setProfile] = useState<ModelOverride>({});
  const [contextWindowInput, setContextWindowInput] = useState('');
  const contextWindow = parseContextWindowInput(contextWindowInput);
  const [numericInputs, setNumericInputs] = useState<
    Partial<Record<'compactionThreshold' | 'maxOutputTokens', string>>
  >({});
  const numericInvalid = Object.values(numericInputs).some(
    (input) => input.trim() !== '' && parseContextWindowInput(input) === null,
  );
  const [submitAttempted, setSubmitAttempted] = useState(false);
  const [isSaving, setSaving] = useState(false);

  const trimmedId = id.trim();
  const idError = !trimmedId
    ? copy.addModelIdRequired
    : props.existingModelIds.includes(trimmedId)
      ? copy.addModelIdDuplicate
      : null;
  const contextWindowError =
    contextWindowInput.trim() !== '' && contextWindow === null
      ? copy.contextWindowInputInvalid
      : null;

  function close() {
    setId('');
    setProfile({});
    setNumericInputs({});
    setContextWindowInput('');
    setSubmitAttempted(false);
    props.onOpenChange(false);
  }

  // Closing on submit would clear the draft before the write settles, and an
  // exact model id is not something a user can reproduce from memory. The
  // failure is reported by the caller's toast; what this owes them is the
  // typed text, still there to retry from.
  async function submit(event: FormEvent) {
    event.preventDefault();
    setSubmitAttempted(true);
    if (idError || contextWindowError || numericInvalid || isSaving) return;
    setSaving(true);
    try {
      const { serviceTier, ...parameters } = profile;
      if (
        await props.onSubmit(trimmedId, {
          ...parameters,
          ...(contextWindow === null ? {} : { contextWindow }),
          ...(supportsRelayFastServiceTier(props.providerType, trimmedId) && serviceTier
            ? { serviceTier }
            : {}),
        })
      )
        close();
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      isOpen={props.isOpen}
      onOpenChange={(open) => {
        // A write in flight owns the draft until it settles: dismissing here
        // would discard the very text the retry needs.
        if (!open && !isSaving) close();
      }}
      purpose="form"
      width={560}
    >
      <Layout
        header={
          <DialogHeader
            title={copy.addModel}
            onOpenChange={(open) => {
              if (!open && !isSaving) close();
            }}
          />
        }
        content={
          <LayoutContent>
            <form id="maka-add-model-form" onSubmit={(event) => void submit(event)}>
              <CapabilityEditor
                copy={copy}
                modelId={trimmedId}
                isRelay={isRelayProviderType(props.providerType)}
                declared={profile}
                onChange={(patch) => setProfile((current) => ({ ...current, ...patch }))}
                contextWindowInput={contextWindowInput}
                contextWindowInputInvalid={submitAttempted && contextWindowError !== null}
                contextWindowError={contextWindowError ?? undefined}
                numericInputs={numericInputs}
                onNumericInput={(field, input) => {
                  setNumericInputs((current) => ({ ...current, [field]: input }));
                  const value = parseContextWindowInput(input);
                  if (value !== null || input.trim() === '')
                    setProfile((current) => ({ ...current, [field]: value ?? undefined }));
                }}
                disabled={isSaving}
                showsFastMode={supportsRelayFastServiceTier(props.providerType, trimmedId)}
                defaultVision={undefined}
                onContextWindowInput={setContextWindowInput}
              >
                <TextInput
                  label={copy.addModelIdField}
                  description={copy.addModelIdFieldHelp}
                  isRequired
                  hasAutoFocus
                  isDisabled={isSaving}
                  value={id}
                  placeholder={copy.addModelIdPlaceholder}
                  onChange={setId}
                  status={
                    submitAttempted && idError ? { type: 'error', message: idError } : undefined
                  }
                />
              </CapabilityEditor>
            </form>
          </LayoutContent>
        }
        footer={
          <LayoutFooter>
            {/* One button, as in scheduled-task-form-dialog: the header's close
                control and Escape are already two ways out, so a footer cancel
                would be a third route to the same place. */}
            <HStack gap={2} hAlign="end">
              <Button
                variant="primary"
                type="submit"
                form="maka-add-model-form"
                isDisabled={props.isSubmitDisabled || isSaving}
                isLoading={isSaving}
                label={copy.addModelConfirm}
              />
            </HStack>
          </LayoutFooter>
        }
      />
    </Dialog>
  );
}
