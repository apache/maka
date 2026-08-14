import { useCallback, useEffect, useState } from 'react';
import { Button, EmptyState, List, ListItem, StatusDot, Switch } from '@astryxdesign/core';
import { ModulePage, dotForStatus, type ModuleHubHeader } from '@maka/ui';
import { FolderOpen, Monitor, RefreshCcw, Trash2, ICON_SIZE } from '@maka/ui/icons';
import type { UiExtensionEntry } from '../preload/bridge-contract.js';

export function UiExtensionsPage({ hubHeader }: { hubHeader: ModuleHubHeader }) {
  const [entries, setEntries] = useState<readonly UiExtensionEntry[]>([]);
  const [busy, setBusy] = useState<string | null>('load');
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(async () => {
    setBusy('load');
    try {
      setEntries(await window.maka.uiExtensions.list());
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  }, []);
  useEffect(() => { void reload(); }, [reload]);

  const act = async (label: string, operation: () => Promise<unknown>) => {
    setBusy(label);
    try {
      await operation();
      await reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setBusy(null);
    }
  };
  const latest = [...entries].reverse().filter((entry, index, all) =>
    all.findIndex((candidate) => candidate.extensionId === entry.extensionId) === index,
  );
  return (
    <main className="maka-main detailPane maka-module-main agents-chat-panel" data-page-shell="layout" data-module="ui-extensions" data-maka-contract="module-main" aria-label="UI Extensions">
      <ModulePage
        title={hubHeader.title}
        meta={`${new Set(entries.map((entry) => entry.extensionId)).size} 个 UI 扩展`}
        actions={<div className="maka-module-main-actions" role="group" aria-label="UI 扩展操作">
          <Button
            variant="primary"
            label={busy === 'import' ? '正在导入…' : '导入 UI 扩展'}
            icon={<FolderOpen size={ICON_SIZE.chrome} aria-hidden="true" />}
            isDisabled={busy !== null}
            onClick={() => void act('import', async () => {
              const result = await window.maka.uiExtensions.importLocal();
              if (!result.ok && result.reason === 'cancelled') return;
            })}
          />
          <Button variant="secondary" label="刷新" icon={<RefreshCcw size={ICON_SIZE.chrome} aria-hidden="true" />} isDisabled={busy !== null} onClick={() => void reload()} />
        </div>}
        toolbar={<div className="maka-module-page-bar">{hubHeader.badge}</div>}
      >
        {error ? <div role="alert" className="maka-module-error">{error}</div> : null}
        {latest.length === 0 && busy === null ? (
          <EmptyState icon={<Monitor size={ICON_SIZE.empty} />} title="还没有 UI 扩展" description="导入包含 maka.ui.json 的本地目录，或让 Agent 动态创建界面。" />
        ) : (
          <List aria-label="已安装 UI 扩展">
            {latest.map((entry) => (
              <ListItem
                key={entry.extensionId}
                label={entry.extensionId}
                description={`${entry.contributionIds.join(', ')} · ${entry.revision.slice(0, 20)}…${entry.error ? ` · ${entry.error}` : ''}`}
                startContent={<StatusDot variant={dotForStatus(entry.status === 'active' ? 'success' : entry.status === 'failed' ? 'error' : 'neutral')} label={entry.status} />}
                endContent={<div className="maka-module-main-actions">
                  <Switch
                    label={`${entry.enabled ? '停用' : '启用'} ${entry.extensionId}`}
                    value={entry.enabled}
                    isDisabled={busy !== null}
                    onChange={(enabled) => void act(`toggle:${entry.extensionId}`, () => window.maka.uiExtensions.setEnabled(entry.extensionId, enabled))}
                  />
                  <Button variant="ghost" label="删除" icon={<Trash2 size={ICON_SIZE.chrome} aria-hidden="true" />} isDisabled={busy !== null} onClick={() => void act(`remove:${entry.extensionId}`, () => window.maka.uiExtensions.remove(entry.extensionId))} />
                </div>}
              />
            ))}
          </List>
        )}
      </ModulePage>
    </main>
  );
}
