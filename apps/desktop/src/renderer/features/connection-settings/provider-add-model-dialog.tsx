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

import { useId, useState, type ReactNode } from 'react';
import { isRelayProviderType, type ProviderType } from '@maka/core/llm-connections';
import { supportsRelayFastServiceTier, modelLimitsConflict, type ModelOverride } from '@maka/core/model-thinking';
import { CapabilityEditor } from './provider-capability-editor.js';
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
    Partial<Record<'inputLimit' | 'compactionThreshold' | 'maxOutputTokens', string>>
  >({});
  const numericInvalid = Object.values(numericInputs).some(
    (input) => input.trim() !== '' && parseContextWindowInput(input) === null,
  );
  const [submitAttempted, setSubmitAttempted] = useState(false);
  const limitsConflict = modelLimitsConflict({ contextWindow: contextWindow ?? undefined, inputLimit: profile.inputLimit });
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
  async function submit() {
    setSubmitAttempted(true);
    if (idError || contextWindowError || numericInvalid || limitsConflict || isSaving) return;
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
    <ModelParametersDialog
      isOpen={props.isOpen}
      title={copy.addModel}
      confirmLabel={copy.addModelConfirm}
      isSaving={isSaving}
      isSubmitDisabled={props.isSubmitDisabled || limitsConflict}
      onClose={close}
      onSubmit={submit}
    >
      <CapabilityEditor
        copy={copy}
        modelId={trimmedId}
        isRelay={isRelayProviderType(props.providerType)}
        declared={profile}
        limitsConflict={limitsConflict}
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
          labelTooltip={copy.addModelIdFieldHelp}
          size="sm"
          isRequired
          hasAutoFocus
          isDisabled={isSaving}
          value={id}
          placeholder={copy.addModelIdPlaceholder}
          onChange={setId}
          status={submitAttempted && idError ? { type: 'error', message: idError } : undefined}
        />
      </CapabilityEditor>
    </ModelParametersDialog>
  );
}

export function ModelParametersDialog(props: {
  isOpen: boolean;
  title: string;
  subtitle?: string;
  confirmLabel: string;
  isSaving: boolean;
  isSubmitDisabled?: boolean;
  onClose(): void;
  onSubmit(): Promise<void>;
  children: ReactNode;
}) {
  const formId = useId();
  const copy = getProviderSettingsCopy(useUiLocale()).detail;
  const close = () => {
    if (!props.isSaving) props.onClose();
  };
  return (
    <Dialog
      isOpen={props.isOpen}
      onOpenChange={(open) => {
        if (!open) close();
      }}
      purpose="form"
      width={440}
    >
      <Layout
        header={
          <DialogHeader
            title={props.title}
            subtitle={props.subtitle}
            onOpenChange={(open) => {
              if (!open) close();
            }}
          />
        }
        content={
          <LayoutContent>
            <form
              id={formId}
              onSubmit={(event) => {
                event.preventDefault();
                if (!props.isSaving && !props.isSubmitDisabled) void props.onSubmit();
              }}
            >
              {props.children}
            </form>
          </LayoutContent>
        }
        footer={
          <LayoutFooter>
            <HStack gap={2} hAlign="end">
              <Button
                variant="ghost"
                label={copy.cancel}
                isDisabled={props.isSaving}
                onClick={close}
              />
              <Button
                variant="primary"
                type="submit"
                form={formId}
                label={props.confirmLabel}
                isDisabled={props.isSaving || props.isSubmitDisabled}
                isLoading={props.isSaving}
              />
            </HStack>
          </LayoutFooter>
        }
      />
    </Dialog>
  );
}
