import { useEffect, useState } from 'react';
import { Card } from '@astryxdesign/core';
import type { ConfigCategory } from '@maka/storage';
import {
  Button,
  SectionHeader,
  Selector,
  Switch,
  clearGlobalInputHistory,
  useMountedRef,
  useToast,
  useUiLocale,
  Banner,
} from '@maka/ui';
import { openPathFailureCopy, openPathActionLabel } from '../open-path';
import { SettingRow } from './settings-rows';
import { settingsActionErrorMessage } from './settings-error-copy';
import { useActionGuard } from './use-action-guard';
import { getDataSettingsCopy, type DataSettingsCopy } from '../locales/settings-data-copy';

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

export function DataSettingsPage() {
  const locale = useUiLocale();
  const copy = getDataSettingsCopy(locale);
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

  useEffect(() => {
    let cancelled = false;
    void window.maka.app.info().then((next) => {
      if (!cancelled) {
        setInfo(next);
        setInfoError(null);
      }
    }).catch((error) => {
      if (cancelled) return;
      const message = settingsActionErrorMessage(error, locale);
      setInfo(null);
      setInfoError(message);
      toast.error(copy.loadFailed, message);
    });
    return () => {
      cancelled = true;
    };
  }, [locale, toast]);

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
        const result = await window.maka.app.openPath('workspace');
        if (!dataPageMountedRef.current) return;
        if (!result.ok) {
          toast.error(
            copy.openFailed(openPathActionLabel('workspace', locale)),
            openPathFailureCopy(result.reason, locale),
          );
        }
      } catch (error) {
        if (dataPageMountedRef.current) {
          toast.error(copy.openFailed(openPathActionLabel('workspace', locale)), settingsActionErrorMessage(error, locale));
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
    if (configBusy) return;
    const categories = [...selectedCategories];
    if (categories.length === 0) {
      toast.error(copy.selectCategory);
      return;
    }
    setConfigBusy('export');
    try {
      const res = await window.maka.config.export({ categories });
      if (res.ok) {
        toast.success(copy.exported, copy.exportedDetail(res.includedData));
      } else if (res.reason !== 'canceled') {
        toast.error(copy.exportFailed, res.reason === 'no_categories' ? copy.noCategories : copy.tryAgain);
      }
    } catch (error) {
      toast.error(copy.exportFailed, settingsActionErrorMessage(error, locale));
    } finally {
      setConfigBusy(null);
    }
  }

  async function importConfig() {
    if (configBusy) return;
    setConfigBusy('import');
    try {
      const res = await window.maka.config.import({ strategy: importStrategy });
      if (res.ok) {
        toast.success(copy.imported, summarizeImportResult(res.result, copy));
      } else if (res.reason !== 'canceled') {
        const detail = res.message && (locale === 'zh' || !/[\u3400-\u9fff]/u.test(res.message))
          ? res.message
          : copy.invalidFile;
        toast.error(copy.importFailed, detail);
      }
    } catch (error) {
      toast.error(copy.importFailed, settingsActionErrorMessage(error, locale));
    } finally {
      setConfigBusy(null);
    }
  }

  return (
    <div className="settingsStructuredPage">
      <Card padding={0} className="settingsRows">
        <SettingRow
          title={copy.rows.workspace}
          detail={copy.rows.workspaceDetail}
          value={info?.workspacePath ?? (infoError ? copy.rows.loadValueFailed : copy.rows.loading)}
          mono
        />
        <SettingRow
          title={copy.rows.storage}
          detail={copy.rows.storageDetail}
          value={copy.rows.localFiles}
        />
        <SettingRow
          title={copy.rows.history}
          detail={copy.rows.historyDetail}
          value={copy.rows.localStorage}
        />
      </Card>
      {/* Detail audit: was two wrapped rows with 打开文件夹 wearing primary
          (a utility action) and destructive 清空输入历史 dressed neutral.
          One row; utilities are secondary; the destructive action reads
          destructive (red outline family, same recipe as the permission
          dialog confirm). */}
      <div className="settingsActionRow" role="group" aria-label={copy.actionsAria}>
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
      </div>
      <Banner status="info" title={copy.backupNotice} />
      {infoError && (
        <Banner status="info" role="alert" title={copy.pathLoadFailed(infoError)} />
      )}
      <section className="settingsConfigSection" aria-label={copy.configAria}>
        <SectionHeader as="h3" title={copy.configTitle} subtitle={copy.configHelp} />
        <div role="group" aria-label={copy.categoryAria} className="settingsConfigCategoryList">
          {CONFIG_CATEGORY_IDS.map((id) => {
            const option = copy.categories[id];
            const checked = selectedCategories.has(id);
            return (
              <Switch
                key={id}
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
            );
          })}
        </div>
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
        <div className="settingsActionRow">
          <Button variant="primary" isDisabled={configBusy !== null} onClick={() => void exportConfig()} label={configBusy === 'export' ? copy.exporting : copy.exportConfig} />
          <Button variant="primary" isDisabled={configBusy !== null} onClick={() => void importConfig()} label={configBusy === 'import' ? copy.importing : copy.importConfig} />
        </div>
      </section>
    </div>
  );
}
