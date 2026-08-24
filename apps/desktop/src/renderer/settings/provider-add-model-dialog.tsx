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
import { Dialog, DialogHeader } from '@astryxdesign/core/Dialog';
import { FormLayout } from '@astryxdesign/core/FormLayout';
import { Layout, LayoutContent, LayoutFooter } from '@astryxdesign/core/Layout';
import { Button, HStack, NumberInput, TextInput, useUiLocale } from '@maka/ui';
import { getProviderSettingsCopy } from '../locales/settings-provider-copy';

/**
 * Introduce a model by exact id, for a provider whose catalog cannot grow on
 * its own: without a model-list endpoint, refresh replays the array this build
 * shipped, so a model the user's plan already serves has no other way in
 * (#1584).
 *
 * Two fields. The id enters `enabledModelIds`, which is the authorization. The
 * context window is the one fact nothing else can supply: an id Maka has never
 * seen resolves no window, and the history budget falls back to a flat 32k
 * (context-budget-policy.ts) — three percent of a 1M-token window.
 *
 * Everything else a user can declare is edited in the capability section below
 * the model list, which shows a row for exactly the models Maka cannot
 * describe — every model added here, the moment it is added.
 */
export function AddModelDialog(props: {
  isOpen: boolean;
  existingModelIds: readonly string[];
  /** Another write is in flight; the store would drop this one on the floor. */
  isSubmitDisabled?: boolean;
  onOpenChange(open: boolean): void;
  /** Resolves to whether the write landed; the draft is held until it did. */
  onSubmit(id: string, contextWindow: number): Promise<boolean>;
}) {
  const copy = getProviderSettingsCopy(useUiLocale()).detail;
  const [id, setId] = useState('');
  const [contextWindow, setContextWindow] = useState<number | null>(null);
  const [submitAttempted, setSubmitAttempted] = useState(false);
  const [isSaving, setSaving] = useState(false);

  const trimmedId = id.trim();
  const idError = !trimmedId
    ? copy.addModelIdRequired
    : props.existingModelIds.includes(trimmedId)
      ? copy.addModelIdDuplicate
      : null;
  // Required, not defaulted: an unknown window falls back to a flat 32k history
  // budget, and guessing higher on the user's behalf would trade a wasted
  // window for requests the provider rejects outright. Whoever types an exact
  // model id is reading the provider's own model page, where this is stated.
  const contextWindowError = contextWindow ? null : copy.addModelContextWindowRequired;

  function close() {
    setId('');
    setContextWindow(null);
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
    if (idError || !contextWindow || isSaving) return;
    setSaving(true);
    try {
      if (await props.onSubmit(trimmedId, contextWindow)) close();
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
      width={480}
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
              <FormLayout>
                {/* The exact id, kept verbatim through selection and inference
                    — `deepseek-v4-pro-beta` is a different model from
                    `deepseek-v4-pro`, and only the user knows which one their
                    plan actually serves. */}
                <TextInput
                  label={copy.addModelIdField}
                  description={copy.addModelIdFieldHelp}
                  isRequired
                  hasAutoFocus
                  value={id}
                  placeholder={copy.addModelIdPlaceholder}
                  onChange={setId}
                  status={
                    submitAttempted && idError ? { type: 'error', message: idError } : undefined
                  }
                />
                <NumberInput
                  label={copy.addModelContextWindow}
                  description={copy.addModelContextWindowHelp}
                  isRequired
                  value={contextWindow}
                  hasClear
                  isIntegerOnly
                  min={1}
                  onChange={setContextWindow}
                  status={
                    submitAttempted && contextWindowError
                      ? { type: 'error', message: contextWindowError }
                      : undefined
                  }
                />
              </FormLayout>
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
