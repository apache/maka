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

import { useEffect, useState } from 'react';
import type { ConfigCategory } from '@maka/storage';
import {
  Button,
  Selector,
  Switch,
  clearGlobalInputHistory,
  useMountedRef,
  useToast,
  useUiLocale,
  Banner,
} from '@maka/ui';
import { openPathFailureCopy, openPathActionLabel } from '../open-path';
import { SettingsActions, SettingsField, SettingsPage, SettingsSection } from './settings-section';
import { SettingRow } from './settings-rows';
import { settingsActionErrorMessage } from './settings-error-copy';
import { useActionGuard } from './use-action-guard';
import { getDataSettingsCopy, type DataSettingsCopy } from '../locales/settings-data-copy';
import { getSettingsSharedCopy } from '../locales/settings-shared-copy.js';
import { useOptionalRuntimeHostSettingsTarget } from './runtime-host-settings-target.js';

const CONFIG_CATEGORY_IDS: readonly ConfigCategory[] = ['connections', 'settings', 'memory', 'credentials'];

type ConfigImportResult = Extract<Awaited<ReturnType<typeof window.maka.config.import>>, { ok: true }>['result'];

function summarizeImportResult(result: ConfigImportResult, copy: DataSettingsCopy): string {
  const parts: string[] = [];
  const conn = result.connections;
  if (conn) parts.push(copy.importSummary.connections(conn.created, conn.overwritten, conn.skipped));
  if (result.settings?.applied) parts.push(copy.importSummary.settings);
  if (result.credentials) {
    const cred = result.credentials;
    parts.push(copy.importSummary.credentials(cred.applied, cred.skipped));
  }
  if (result.memory?.applied) parts.push(copy.importSummary.memory);
  return parts.join(' · ') || copy.importSummary.empty;
}

export function DataSettingsPage(props: {
  runtimeHostStatus: 'loading' | 'ready' | 'unavailable' | 'error';
  onRetryRuntimeHost(): Promise<void>;
}) {
  const host = useOptionalRuntimeHostSettingsTarget();
  const locale = useUiLocale();
  const copy = getDataSettingsCopy(locale);
  const sharedCopy = getSettingsSharedCopy(locale);
  const [info, setInfo] = useState<Awaited<ReturnType<typeof window.maka.app.info>> | null>(null);
  const [infoError, setInfoError] = useState<string | null>(null);
  const [pendingDataAction, setPendingDataAction] = useState<string | null>(null);
  const dataActionGuard = useActionGuard<string>();
  const dataPageMountedRef = useMountedRef();
  const toast = useToast();
  const [selectedCategories, setSelectedCategories] = useState<Set<ConfigCategory>>(
    () => new Set<ConfigCategory>(['connections', 'settings']),
  );
  const [importStrategy, setImportStrategy] = useState<'skip' | 'overwrite'>('skip');
  const [configBusy, setConfigBusy] = useState<null | 'export' | 'import'>(null);
  const runtimeHostAvailable = host !== undefined && props.runtimeHostStatus === 'ready';
  const diagnosticTarget = host ? { profileId: host.profileId } : undefined;

  useEffect(() => {
    if (!host) {
      setInfo(null);
      setInfoError(null);
      return;
    }
    let cancelled = false;
    void window.maka.app.info(host).then((next) => {
      if (!cancelled) {
        setInfo(next);
        setInfoError(null);
      }
    }).catch((error) => {
      if (cancelled) return;
      const message = settingsActionErrorMessage(error, locale);
      setInfo(null);
      setInfoError(message);
      toast.error(copy.loadFailed, message, undefined, diagnosticTarget);
    });
    return () => {
      cancelled = true;
    };
  }, [host, locale, toast]);

  async function runDataAction(action: string, run: () => Promise<void>) {
    if (!dataActionGuard.begin(action)) return;
    setPendingDataAction(action);
    try {
      await run();
    } finally {
      dataActionGuard.finish();
      if (dataPageMountedRef.current) {
        setPendingDataAction(null);
      }
    }
  }

  const isDataActionPending = (action: string) => pendingDataAction === action;
  const dataActionDisabled = Boolean(pendingDataAction);

  async function openWorkspace() {
    if (!info) return;
    await runDataAction('workspace:open', async () => {
      try {
        const result = await window.maka.app.openPath('workspace', undefined, host);
        if (!dataPageMountedRef.current) return;
        if (!result.ok) {
          toast.error(
            copy.openFailed(openPathActionLabel('workspace', locale)),
            openPathFailureCopy(result.reason, locale),
            undefined,
            diagnosticTarget,
          );
        }
      } catch (error) {
        if (dataPageMountedRef.current) {
          toast.error(
            copy.openFailed(openPathActionLabel('workspace', locale)),
            settingsActionErrorMessage(error, locale),
            undefined,
            diagnosticTarget,
          );
        }
      }
    });
  }

  async function copyPath() {
    if (!info) return;
    await runDataAction('workspace:path:copy', async () => {
      try {
        await navigator.clipboard.writeText(info.workspacePath);
        if (dataPageMountedRef.current) {
          toast.success(copy.pathCopied);
        }
      } catch {
        if (dataPageMountedRef.current) {
          toast.error(copy.copyFailed, copy.copyFailedDetail);
        }
      }
    });
  }

  async function clearInputHistory() {
    await runDataAction('input-history:clear', async () => {
      clearGlobalInputHistory();
      if (dataPageMountedRef.current) {
        toast.success(copy.historyCleared, copy.historyClearedDetail);
      }
    });
  }

  function toggleCategory(id: ConfigCategory) {
    setSelectedCategories((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function exportConfig() {
    if (configBusy || !host) return;
    const categories = [...selectedCategories];
    if (categories.length === 0) {
      toast.error(copy.selectCategory);
      return;
    }
    setConfigBusy('export');
    try {
      const res = await window.maka.config.export({ categories }, host);
      if (res.ok) {
        toast.success(copy.exported, copy.exportedDetail(res.includedData));
      } else if (res.reason !== 'canceled') {
        toast.error(
          copy.exportFailed,
          res.reason === 'no_categories' ? copy.noCategories : copy.tryAgain,
          undefined,
          diagnosticTarget,
        );
      }
    } catch (error) {
      toast.error(
        copy.exportFailed,
        settingsActionErrorMessage(error, locale),
        undefined,
        diagnosticTarget,
      );
    } finally {
      setConfigBusy(null);
    }
  }

  async function importConfig() {
    if (configBusy || !host) return;
    setConfigBusy('import');
    try {
      const res = await window.maka.config.import({ strategy: importStrategy }, host);
      if (res.ok) {
        toast.success(copy.imported, summarizeImportResult(res.result, copy));
      } else if (res.reason !== 'canceled') {
        const detail = res.message && (locale === 'zh' || !/[\u3400-\u9fff]/u.test(res.message))
          ? res.message
          : copy.invalidFile;
        toast.error(copy.importFailed, detail, undefined, diagnosticTarget);
      }
    } catch (error) {
      toast.error(
        copy.importFailed,
        settingsActionErrorMessage(error, locale),
        undefined,
        diagnosticTarget,
      );
    } finally {
      setConfigBusy(null);
    }
  }

  return (
    <SettingsPage>
      {!runtimeHostAvailable ? (
        <Banner
          status={props.runtimeHostStatus === 'error' ? 'error' : 'warning'}
          title={props.runtimeHostStatus === 'loading'
            ? sharedCopy.loading
            : sharedCopy.runtimeHostUnavailable}
          endContent={props.runtimeHostStatus === 'error' ? (
            <Button
              variant="secondary"
              size="sm"
              label={sharedCopy.retry}
              onClick={() => void props.onRetryRuntimeHost()}
            />
          ) : undefined}
        />
      ) : null}
      <SettingsSection
        title={sharedCopy.groups.dataLocation}
        description={sharedCopy.groups.dataLocationHelp}
      >
        <SettingRow
          title={copy.rows.workspace}
          detail={copy.rows.workspaceDetail}
          value={info?.workspacePath ?? (infoError ? copy.rows.loadValueFailed : copy.rows.loading)}
          mono
        />
        {/* UX audit (owner msg `30f736ed`): the 存储引擎 row read
            「存储引擎 · 本地文件」— a privacy claim, not a setting, and the
            group description above already makes it. It moved into that
            description; the row is gone.

            输入历史 keeps its row because it has an action, but not its right
            value: 「本机 localStorage」named an implementation, and there is
            nothing a user does with that name. */}
        <SettingRow
          title={copy.rows.history}
          detail={copy.rows.historyDetail}
        />
        {/* Detail audit: was two wrapped rows with 打开文件夹 wearing primary
            (a utility action) and destructive 清空输入历史 dressed neutral.
            One row; utilities are secondary; the destructive action reads
            destructive. Lives in the card它作用于的数据 — it was a loose
            cluster floating on the page background before. */}
        <SettingsActions role="group" aria-label={copy.actionsAria}>
        <Button
          variant="secondary"
          onClick={() => void openWorkspace()}
          isDisabled={!info || dataActionDisabled}
          label={isDataActionPending('workspace:open') ? copy.opening : copy.openWorkspace}
        />
        <Button
          variant="secondary"
          onClick={() => void copyPath()}
          isDisabled={!info || dataActionDisabled}
          label={isDataActionPending('workspace:path:copy') ? copy.copying : copy.copyPath}
        />
        <Button
          variant="destructive"
          onClick={() => void clearInputHistory()}
          isDisabled={dataActionDisabled}
          label={isDataActionPending('input-history:clear') ? copy.clearing : copy.clearHistory}
        />
        </SettingsActions>
      </SettingsSection>
      {/* Banner requires a title, and renders it semibold in the status color.
          The three-line advisory is body copy, so it moves to `description`
          and the title states what the advisory is about — previously the
          whole paragraph printed as bold blue with no heading. */}
      {/* Guidance, not an alert — a full blue Banner between sections was
          color as texture. Quiet titled prose keeps the same content. */}
      <div className="settingsQuietCallout">
        <strong>{copy.backupTitle}</strong>
        <p>{copy.backupNotice}</p>
      </div>
      {infoError && (
        <Banner status="info" role="alert" title={copy.pathLoadFailed(infoError)} />
      )}
      {/* Was variant="bare": four Switch rows, a Selector, and a button row
          floating directly on the page background — the only group on the
          settings surface without a card. Same rows vocabulary as every
          other group now; the Switch's own label/description layout IS the
          row, so each one is a SettingsField (padded, divided) rather than
          a re-labeled SettingsRow. */}
      {runtimeHostAvailable ? <SettingsSection
        title={copy.configTitle}
        description={copy.configHelp}
      >
        <div role="group" aria-label={copy.categoryAria} className="settingsRowsGroup">
          {CONFIG_CATEGORY_IDS.map((id) => {
            const option = copy.categories[id];
            const checked = selectedCategories.has(id);
            return (
              <SettingsField key={id}>
                <Switch
                  label={option.label}
                  description={option.detail}
                  value={checked}
                  width="100%"
                  labelPosition="start"
                  labelSpacing="spread"
                  status={
                    option.sensitive && checked
                      ? { type: 'warning', message: copy.sensitiveWarning }
                      : undefined
                  }
                  onChange={() => toggleCategory(id)}
                />
              </SettingsField>
            );
          })}
        </div>
        <SettingsField>
          <Selector
            value={importStrategy}
            label={copy.conflictAria}
            options={
              [
                { value: 'skip', label: copy.skip },
                { value: 'overwrite', label: copy.overwrite },
              ]
            }
            width="100%"
            onChange={(strategy) => setImportStrategy(strategy as typeof importStrategy)}
          />
        </SettingsField>
        <SettingsActions>
          {/* clickAction owns the in-flight affordance: same-tick dedupe, the
              delayed spinner, aria-busy, and the live-region announcement — a
              label that swapped to 导出中… said the same thing in a way a
              screen reader had to re-read the button to notice. `configBusy`
              stays because it is the *cross-button* rule (one config operation
              at a time), which is not a thing a single control can know. */}
          <Button variant="primary" isDisabled={configBusy !== null} clickAction={() => exportConfig()} label={copy.exportConfig} />
          {/* One primary per action row: export is the action this section
              is titled after; import is the inverse operation and reads
              secondary. Two filled buttons recommended neither. */}
          <Button variant="secondary" isDisabled={configBusy !== null} clickAction={() => importConfig()} label={copy.importConfig} />
        </SettingsActions>
      </SettingsSection> : null}
    </SettingsPage>
  );
}
