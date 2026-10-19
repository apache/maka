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

import { useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Banner, Button, HStack, Selector, Text, VStack } from '@astryxdesign/core';
import { Dialog, DialogHeader } from '@astryxdesign/core/Dialog';
import { Layout, LayoutContent, LayoutFooter } from '@astryxdesign/core/Layout';
import {
  providerSupportsModelDiscovery,
  type ProjectedLlmConnection,
} from '@maka/core/llm-connections';
import { useMountedRef, useUiLocale } from '@maka/ui';
import { getProviderSettingsCopy } from './settings-provider-copy.js';
import { providerPanelActionErrorMessage } from './provider-panel-shared.js';
import type { ConnectionsBridge } from './ports.js';
import { AddModelDialog } from './provider-add-model-dialog.js';
import type { ModelOverride } from '@maka/core/model-thinking';
import { useRuntimeHostSettingsErrorReporter } from '../../application/contracts/settings-presentation/runtime-host-settings-target.js';

export function ConnectionDefaultAction(props: {
  connection: ProjectedLlmConnection;
  bridge: ConnectionsBridge;
  onChanged(): Promise<void>;
  children(action: ReactNode): ReactNode;
}) {
  const { connection } = props;
  const locale = useUiLocale();
  const { panel: copy, detail } = getProviderSettingsCopy(locale);
  const reportError = useRuntimeHostSettingsErrorReporter();
  const mounted = useMountedRef();
  const inFlight = useRef(false);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [addingModel, setAddingModel] = useState(false);
  const [modelId, setModelId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const models = connection.catalogEntries.filter((entry) => entry.canUseAsChatDefault);
  const enabled = models.filter((entry) => connection.enabledModelIds?.includes(entry.id));
  const choices = enabled.length > 0 ? enabled : models;
  const selected = choices.find((entry) => entry.id === modelId);
  const needsEnable = selected !== undefined && !connection.enabledModelIds?.includes(selected.id);
  const identity = { connectionId: connection.connectionId, slug: connection.slug };

  function close() {
    if (inFlight.current) return;
    setOpen(false);
    setModelId('');
    setError(null);
  }

  async function setDefault(id: string) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    let committed = false;
    try {
      await props.bridge.setDefault(identity, id);
      committed = true;
      if (!mounted.current) return;
      setOpen(false);
      setModelId('');
      await props.onChanged();
    } catch (cause) {
      if (!mounted.current) return;
      const raw = cause instanceof Error ? cause.message : String(cause);
      const message = /DEFAULT_CONNECTION_CHANGED/.test(raw)
        ? copy.defaultConnectionChanged
        : /DEFAULT_MODEL_UNAVAILABLE/.test(raw)
          ? copy.defaultModelUnavailable
          : /Connection has no enabled model/.test(raw)
            ? copy.enableDefaultModelHelp
            : providerPanelActionErrorMessage(cause, locale);
      if (open && !committed) setError(message);
      else reportError(committed ? detail.refreshFailed : copy.setDefaultFailed, message);
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  async function fetchModels() {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      await props.bridge.fetchModels(identity, { preserveSelection: true });
      if (mounted.current) await props.onChanged();
    } catch (cause) {
      if (mounted.current) setError(providerPanelActionErrorMessage(cause, locale));
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  async function addModel(id: string, profile: ModelOverride): Promise<boolean> {
    if (inFlight.current) return false;
    inFlight.current = true;
    setBusy(true);
    let saved = false;
    try {
      // Adding a candidate does not enable it: the default confirmation owns
      // that choice and commits the selection together with the default.
      await props.bridge.update(identity, {
        modelOverride: { modelId: id, expected: null, value: profile },
      });
      saved = true;
      if (!mounted.current) return true;
      await props.onChanged();
      if (!mounted.current) return true;
      setModelId(id);
      setOpen(true);
      return true;
    } catch (cause) {
      if (mounted.current)
        reportError(
          saved ? detail.refreshFailed : detail.saveModelsFailed,
          providerPanelActionErrorMessage(cause, locale),
        );
      return saved;
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  return (
    <>
      {props.children(
        <Button
          variant="secondary"
          size="sm"
          label={copy.setDefault}
          tooltip={connection.enabled ? copy.setDefaultTitle : copy.defaultConnectionDisabled}
          isDisabled={busy || !connection.enabled}
          isLoading={busy && !open}
          clickAction={async () => {
            if (enabled.length === 1) await setDefault(enabled[0]!.id);
            else {
              setError(null);
              setModelId('');
              setOpen(true);
            }
          }}
        />,
      )}
      {/* Keep dialogs outside the header Toolbar's keyboard-navigation context. */}
      {typeof document !== 'undefined' &&
        createPortal(
          <Dialog
            isOpen={open}
            onOpenChange={(next) => {
              if (!next) close();
            }}
            purpose="form"
            width={440}
          >
            <Layout
              header={
                <DialogHeader
                  title={copy.chooseDefaultModel}
                  subtitle={connection.name}
                  onOpenChange={(next) => {
                    if (!next) close();
                  }}
                />
              }
              content={
                <LayoutContent>
                  <VStack gap={4}>
                    <Text>
                      {choices.length === 0
                        ? copy.defaultModelsEmpty
                        : enabled.length === 0
                          ? copy.enableDefaultModelHelp
                          : copy.chooseDefaultModelHelp}
                    </Text>
                    {error && <Banner status="error" title={error} />}
                    {choices.length > 0 ? (
                      <Selector
                        label={copy.defaultModelField}
                        placeholder={copy.defaultModelRequired}
                        value={selected?.id ?? ''}
                        onChange={setModelId}
                        isDisabled={busy}
                        hasSearch
                        options={choices.map((entry) => ({
                          value: entry.id,
                          label: entry.displayName?.trim() || entry.id,
                        }))}
                      />
                    ) : (
                      <HStack gap={2} wrap="wrap">
                        {providerSupportsModelDiscovery(connection.providerType) && (
                          <Button
                            variant="secondary"
                            label={copy.fetchDefaultModels}
                            isDisabled={busy}
                            isLoading={busy}
                            clickAction={fetchModels}
                          />
                        )}
                        <Button
                          variant="secondary"
                          label={copy.addDefaultModel}
                          isDisabled={busy}
                          onClick={() => {
                            close();
                            setAddingModel(true);
                          }}
                        />
                      </HStack>
                    )}
                  </VStack>
                </LayoutContent>
              }
              footer={
                <LayoutFooter>
                  <HStack gap={2} hAlign="end">
                    <Button
                      variant="ghost"
                      label={detail.cancel}
                      isDisabled={busy}
                      onClick={close}
                    />
                    {choices.length > 0 && (
                      <Button
                        variant="primary"
                        label={needsEnable ? copy.enableAndSetDefault : copy.setDefault}
                        isDisabled={busy || !selected}
                        isLoading={busy}
                        clickAction={async () => {
                          if (selected) await setDefault(selected.id);
                        }}
                      />
                    )}
                  </HStack>
                </LayoutFooter>
              }
            />
          </Dialog>,
          document.body,
        )}
      {typeof document !== 'undefined' &&
        createPortal(
          <AddModelDialog
            isOpen={addingModel}
            providerType={connection.providerType}
            defaultApiProtocol={connection.defaultApiProtocol}
            existingModelIds={connection.catalogEntries.map((entry) => entry.id)}
            isSubmitDisabled={busy}
            onOpenChange={setAddingModel}
            onSubmit={addModel}
          />,
          document.body,
        )}
    </>
  );
}
