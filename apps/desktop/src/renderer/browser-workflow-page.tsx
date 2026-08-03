import { useEffect, useMemo, useState } from 'react';
import type {
  BrowserWorkflow,
  BrowserWorkflowAction,
  BrowserWorkflowLocator,
} from '@maka/core/browser-workflow';
import {
  Button,
  EmptyState,
  PageHeader,
  TextInput,
  type ModuleHubHeader,
  useToast,
  useUiLocale,
} from '@maka/ui';
import { Pencil, Play, Save, Trash2 } from '@maka/ui/icons';
import { getBrowserWorkflowCopy } from './locales/browser-workflow-copy';

export function BrowserWorkflowPage(props: {
  hubHeader?: ModuleHubHeader;
  activeSessionId: string | null;
  onRun?(workflowId: string, sensitiveValues: Record<string, string>): Promise<void>;
}) {
  const locale = useUiLocale();
  const copy = getBrowserWorkflowCopy(locale);
  const toast = useToast();
  const [workflows, setWorkflows] = useState<BrowserWorkflow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [deleteConfirmationId, setDeleteConfirmationId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState('');
  const [sensitiveValues, setSensitiveValues] = useState<Record<string, Record<string, string>>>({});
  const [progress, setProgress] = useState<Record<string, { runId: string; current: number; total: number; status: string }>>({});

  async function reload() {
    setLoading(true);
    try {
      setWorkflows(await window.maka.browser.workflows.list());
    } catch (error) {
      toast.error(copy.reload, error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void reload();
    return window.maka.browser.workflows.onProgress((event) => {
      if (event.workflowId !== 'recording') {
        setProgress((current) => ({ ...current, [event.workflowId]: { runId: event.runId, current: event.current, total: event.total, status: event.status } }));
      }
    });
  }, [locale]);

  const workflowActions = useMemo(
    () =>
      new Map(
        workflows.map((workflow) => [
          workflow.id,
          workflow.actions.flatMap((action, index) =>
            action.kind === 'type' && action.sensitive ? [{ action, step: index + 1 }] : [],
          ),
        ]),
      ),
    [workflows],
  );

  async function run(workflow: BrowserWorkflow) {
    if (!props.activeSessionId) {
      toast.error(copy.runFailed, copy.noSession);
      return;
    }
    setBusy(workflow.id);
    try {
      const values = sensitiveValues[workflow.id] ?? {};
      if (props.onRun) await props.onRun(workflow.id, values);
      else await window.maka.browser.workflows.run(workflow.id, props.activeSessionId, values);
    } catch (error) {
      toast.error(copy.runFailed, error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  }

  async function saveName(workflow: BrowserWorkflow) {
    if (!editingName.trim()) return;
    setBusy(workflow.id);
    try {
      const next = await window.maka.browser.workflows.rename(workflow.id, editingName);
      setWorkflows((current) => current.map((entry) => (entry.id === next.id ? next : entry)));
      setEditingId(null);
    } catch (error) {
      toast.error(copy.renameFailed, error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  }

  async function remove(workflow: BrowserWorkflow) {
    setBusy(workflow.id);
    try {
      await window.maka.browser.workflows.delete(workflow.id);
      setWorkflows((current) => current.filter((entry) => entry.id !== workflow.id));
      setDeleteConfirmationId(null);
    } catch (error) {
      toast.error(copy.deleteFailed, error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  }

  return (
    <main className="maka-main detailPane maka-module-main agents-chat-panel" aria-label={props.hubHeader?.title ?? copy.title}>
      <PageHeader
        className="maka-module-main-header"
        title={props.hubHeader?.title ?? copy.title}
        subtitle={props.hubHeader?.subtitle ?? copy.subtitle}
        badge={props.hubHeader?.badge}
        headingRowClassName={props.hubHeader ? 'maka-module-hub-heading' : undefined}
      />
      {loading ? (
        <div role="status" aria-busy="true" className="maka-lazy-fallback">{copy.reload}</div>
      ) : workflows.length === 0 ? (
        <EmptyState title={copy.title} description={copy.empty} />
      ) : (
        <div className="maka-browser-workflow-list" data-maka-contract="browser-workflow-list">
          {workflows.map((workflow) => {
            const sensitive = workflowActions.get(workflow.id) ?? [];
            const status = progress[workflow.id];
            return (
              <article key={workflow.id} className="maka-browser-workflow-row">
                <div className="maka-browser-workflow-row-heading">
                  {editingId === workflow.id ? (
                    <TextInput label={copy.rename} isLabelHidden value={editingName} onChange={setEditingName} />
                  ) : (
                    <h2>{workflow.name}</h2>
                  )}
                  <span>{copy.savedAt(new Date(workflow.updatedAt).toLocaleString(locale === 'zh' ? 'zh-CN' : 'en-US'), workflow.actions.length)}</span>
                </div>
                {sensitive.length > 0 && (
                  <div className="maka-browser-workflow-sensitive-fields">
                    {sensitive.map(({ action, step }) => (
                      <TextInput
                        key={action.id}
                        type="password"
                        label={copy.sensitiveValue(step, describeLocator(action.locator))}
                        value={sensitiveValues[workflow.id]?.[action.id] ?? ''}
                        onChange={(value) => setSensitiveValues((current) => ({
                          ...current,
                          [workflow.id]: { ...current[workflow.id], [action.id]: value },
                        }))}
                      />
                    ))}
                  </div>
                )}
                <details className="maka-browser-workflow-preview">
                  <summary>{copy.preview}</summary>
                  <ol>
                    {workflow.actions.map((action) => (
                      <li key={action.id}>{describeAction(action, copy)}</li>
                    ))}
                  </ol>
                </details>
                <div className="maka-browser-workflow-row-actions">
                  {status?.status === 'running' ? (
                    <>
                      <span role="status">{copy.running} {status.current}/{status.total}</span>
                      <Button variant="ghost" label={copy.cancel} onClick={() => window.maka.browser.workflows.cancel(status.runId)} />
                    </>
                  ) : (
                    <Button variant="primary" icon={<Play aria-hidden="true" />} label={copy.run} isDisabled={busy !== null} onClick={() => void run(workflow)} />
                  )}
                  {editingId === workflow.id ? (
                    <Button variant="ghost" icon={<Save aria-hidden="true" />} label={copy.save} isDisabled={busy === workflow.id} onClick={() => void saveName(workflow)} />
                  ) : (
                    <Button variant="ghost" icon={<Pencil aria-hidden="true" />} label={copy.rename} isDisabled={busy !== null} onClick={() => { setEditingId(workflow.id); setEditingName(workflow.name); }} />
                  )}
                  {deleteConfirmationId === workflow.id ? (
                    <>
                      <span role="status">{copy.confirmDeletePrompt(workflow.name)}</span>
                      <Button variant="ghost" label={copy.cancel} isDisabled={busy === workflow.id} onClick={() => setDeleteConfirmationId(null)} />
                      <Button variant="destructive" icon={<Trash2 aria-hidden="true" />} label={copy.confirmDelete} isDisabled={busy === workflow.id} onClick={() => void remove(workflow)} />
                    </>
                  ) : (
                    <Button variant="ghost" icon={<Trash2 aria-hidden="true" />} label={copy.delete} isDisabled={busy !== null} onClick={() => setDeleteConfirmationId(workflow.id)} />
                  )}
                </div>
              </article>
            );
          })}
        </div>
      )}
    </main>
  );
}

function describeLocator(locator: BrowserWorkflowLocator): string {
  return `${locator.kind.replace('_', ' ')}: ${locator.value}`;
}

function describeAction(
  action: BrowserWorkflowAction,
  copy: ReturnType<typeof getBrowserWorkflowCopy>,
): string {
  switch (action.kind) {
    case 'navigate':
      return copy.navigateAction(action.url);
    case 'click':
      return copy.clickAction(describeLocator(action.locator));
    case 'check':
      return copy.checkAction(describeLocator(action.locator), action.checked);
    case 'type':
      return copy.typeAction(describeLocator(action.locator), action.sensitive);
    case 'wait':
      return action.navigation
        ? copy.waitNavigationAction
        : copy.waitAction(action.url ?? action.selector ?? action.text ?? '');
  }
}
