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

import { useEffect, useState, type ReactNode } from 'react';
import { Button, Popover } from '@astryxdesign/core';
import type {
  ExecutorCatalogEntry,
  ExecutorConfiguration,
  ExecutorSelection,
} from '@maka/core/executor-catalog';
export type { ExecutorSelection } from '@maka/core/executor-catalog';
import type { ProviderType } from '@maka/core/llm-connections';
import type { UiCatalog, UiLocale } from '@maka/core/ui-locale';
import { Settings, ICON_SIZE } from './icons.js';
import { ModelPickerPanel, ModelPickerPanelContext } from './model-picker-panel.js';
import { ComposerModelLabel } from './composer-model-label.js';
import { providerMarkIcon } from './model-picker-internals.js';
import { executorModelGroup, highestExecutorModelVariant } from './executor-model-presentation.js';
import { ThinkingLevelSelector } from './chat-model-switcher.js';
import { useUiLocale } from './locale-context.js';

export interface ExecutorModelPickerProps {
  catalog: readonly ExecutorCatalogEntry[];
  selection?: ExecutorSelection;
  nativeLabel?: string;
  nativeThinkingControl?: ReactNode;
  onPendingChange?(pending: boolean): void;
  renderProviderMark?(type: ProviderType): ReactNode;
  children?: ReactNode;
  presentation?: 'popover' | 'bottom-sheet' | 'wheel';
  isReadOnly?: boolean;
  fixed?: boolean;
  disabled?: boolean;
  loading?: boolean;
  error?: string;
  onSelect(selection: ExecutorSelection | undefined): void | Promise<void>;
  onSetup(): void;
  onRetry(): void;
  onNewTask(): void;
}

interface ExecutorCopy {
  title: string;
  nativeOperations: string;
  search: string;
  manage: string;
  default: string;
  loading: string;
  unavailable: string;
  authentication_required: string;
  history_only: string;
  fixed: string;
  attachments: string;
  retry: string;
  newTask: string;
  selectionFailed: string;
}

const EXECUTOR_COPY = {
  en: {
    title: 'Executor',
    nativeOperations: 'This operation requires Maka. Start a new Maka task.',
    search: 'Search models',
    manage: 'Manage external agents',
    default: 'Agent default',
    loading: 'Loading agents and models…',
    unavailable: 'Unavailable. Check setup and retry.',
    authentication_required: 'Sign in from External Agents settings.',
    history_only:
      'The external process was lost. History is readable; start a new task to continue.',
    fixed: 'Start a new task to switch executors.',
    attachments:
      'This executor does not support these attachments. Remove them or select Maka. Your draft is preserved.',
    retry: 'Retry',
    newTask: 'New task',
    selectionFailed: 'Model change failed. Try again.',
  },
  'zh-CN': {
    title: '执行者',
    nativeOperations: '此操作仅支持 Maka。请新建 Maka 任务。',
    search: '搜索模型',
    manage: '管理外部 Agent',
    default: 'Agent 默认',
    loading: '正在读取执行者与模型…',
    unavailable: '当前不可用，请检查设置后重试。',
    authentication_required: '需要登录，请前往外部 Agent 设置。',
    history_only: '外部进程已丢失。历史仍可阅读，请新建任务继续。',
    fixed: '切换执行者需要新建任务。',
    attachments: '此执行者不支持这些附件。请移除附件或选择 Maka，草稿会保留。',
    retry: '重试',
    newTask: '新建任务',
    selectionFailed: '模型切换失败，请重试。',
  },
  'zh-TW': {
    title: '執行者',
    nativeOperations: '此操作僅支援 Maka。請建立 Maka 任務。',
    search: '搜尋模型',
    manage: '管理外部 Agent',
    default: 'Agent 預設',
    loading: '正在讀取執行者與模型…',
    unavailable: '目前無法使用，請檢查設定後重試。',
    authentication_required: '需要登入，請前往外部 Agent 設定。',
    history_only: '外部程序已遺失。歷史仍可閱讀，請建立新任務繼續。',
    fixed: '切換執行者需要建立新任務。',
    attachments: '此執行者不支援這些附件。請移除附件或選擇 Maka，草稿會保留。',
    retry: '重試',
    newTask: '建立新任務',
    selectionFailed: '模型切換失敗，請重試。',
  },
} satisfies UiCatalog<ExecutorCopy>;

export function executorCopy(locale: UiLocale): ExecutorCopy {
  return EXECUTOR_COPY[locale];
}

const NATIVE = '__maka_native__';

/** Browsing is local; choosing a model commits executor and configuration together. */
export function ExecutorModelPicker(props: ExecutorModelPickerProps) {
  const locale = useUiLocale();
  const copy = executorCopy(locale);
  const selected = props.catalog.find((entry) => entry.id === props.selection?.executorId);
  const [open, setOpen] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const [selectionFailed, setSelectionFailed] = useState(false);
  const [browsedId, setBrowsedId] = useState(props.selection?.executorId ?? NATIVE);
  useEffect(() => {
    if (!open) {
      setBrowsedId(props.selection?.executorId ?? NATIVE);
      setSelectionFailed(false);
    }
  }, [open, props.selection?.executorId]);
  useEffect(() => { props.onPendingChange?.(selecting); }, [selecting, props.onPendingChange]);
  useEffect(() => () => props.onPendingChange?.(false), [props.onPendingChange]);
  const browsed = props.catalog.find((entry) => entry.id === browsedId);
  const currentModel =
    browsedId === props.selection?.executorId
      ? (props.selection?.configuration.model ?? browsed?.currentModel)
      : browsed?.currentModel;
  const selectedUnavailable = !!props.selection && selected?.readiness !== 'ready';
  const selectedModel = props.selection?.configuration.model ?? selected?.currentModel;
  const selectedGroup = selected && executorModelGroup(selected, selectedModel);
  const currentGroup = browsed && executorModelGroup(browsed, currentModel);
  const triggerLabel = props.selection
    ? `${selected?.displayName ?? props.selection.executorId} · ${
        selectedGroup?.name ?? selected?.models.find(model => model.id === selectedModel)?.name ?? selectedModel ?? copy.default
      }`
    : (props.nativeLabel ?? 'Maka');
  const chooseModel = async (configuration: ExecutorConfiguration, entry = browsed) => {
    if (!entry || entry.readiness !== 'ready' || props.disabled || props.isReadOnly || selecting ||
      (props.fixed && !entry.supportsModelChange)) return;
    setSelecting(true);
    setSelectionFailed(false);
    try {
      await props.onSelect({ executorId: entry.id, configuration });
      setOpen(false);
    } catch {
      // Keep the surface open so the owner's error state can explain the failed commit.
      setSelectionFailed(true);
    } finally {
      setSelecting(false);
    }
  };
  const browse = (id: string) => {
    setBrowsedId(id);
    setSelectionFailed(false);
  };
  const openSetup = () => {
    setOpen(false);
    props.onSetup();
  };
  const openNewTask = () => {
    setOpen(false);
    props.onNewTask();
  };
  const lockedTo = props.fixed ? props.selection?.executorId ?? NATIVE : undefined;
  return (
    <>
      <Popover
        label={copy.title}
        placement="above"
        width="min(620px, 92vw)"
        isOpen={open}
        onOpenChange={setOpen}
        isEnabled={!props.disabled && !props.isReadOnly}
        content={
          <div className="maka-executor-picker-panel">
            <nav className="maka-executor-picker-rail" aria-label={copy.title}>
              <Button
                label="Maka"
                variant="ghost"
                size="sm"
                className="maka-executor-picker-entry"
                data-active={browsedId === NATIVE ? 'true' : undefined}
                isDisabled={lockedTo !== undefined && lockedTo !== NATIVE}
                onClick={() => browse(NATIVE)}
              />
              {props.catalog.map((entry) => (
                <Button
                  key={entry.id}
                  label={entry.displayName}
                  variant="ghost"
                  size="sm"
                  className="maka-executor-picker-entry"
                  data-active={browsedId === entry.id ? 'true' : undefined}
                  isDisabled={lockedTo !== undefined && lockedTo !== entry.id}
                  onClick={() => browse(entry.id)}
                >
                  <span className="maka-executor-picker-label">
                    <span>{entry.displayName}</span>
                    {entry.readiness !== 'ready' ? (
                      <span className="maka-executor-picker-entry-status">
                        {copy[entry.readiness]}
                      </span>
                    ) : null}
                  </span>
                </Button>
              ))}
              {props.loading ? (
                <span className="maka-executor-picker-entry-status" role="status">{copy.loading}</span>
              ) : null}
              <Button
                label={copy.manage}
                variant="ghost"
                size="sm"
                icon={<Settings size={ICON_SIZE.control} aria-hidden="true" />}
                className="maka-executor-picker-entry maka-executor-picker-manage"
                onClick={openSetup}
              />
            </nav>
            <section className="maka-executor-picker-models" aria-live="polite">
              {browsedId === NATIVE ? (
                <ModelPickerPanelContext.Provider value={{ onSelected: () => setOpen(false) }}>
                  <div className="maka-executor-picker-native">{props.children}</div>
                </ModelPickerPanelContext.Provider>
              ) : browsed?.readiness === 'ready' ? (
                <>
                  <ModelPickerPanel
                    key={browsed.id}
                    value={currentGroup ? `group:${currentGroup.id}` : `model:${currentModel}`}
                    disabled={props.disabled || props.isReadOnly || selecting || (props.fixed && !browsed.supportsModelChange)}
                    options={browsed.models.flatMap((model) => {
                      const group = executorModelGroup(browsed, model.id);
                      if (group && browsed.models.find(candidate => group.variants.some(variant => variant.modelId === candidate.id))?.id !== model.id) return [];
                      return [{
                        value: group ? `group:${group.id}` : `model:${model.id}`,
                        label: group?.name ?? model.name,
                        detail: group ? undefined : model.id,
                        description: group?.variants.map(variant => variant.modelId).join(' '),
                        icon: providerMarkIcon(model.providerType, props.renderProviderMark),
                      }];
                    })}
                    onSelect={(value) => {
                      const group = browsed.modelGroups?.find(candidate => `group:${candidate.id}` === value);
                      const model = group
                        ? highestExecutorModelVariant(group)
                        : value.slice('model:'.length);
                      if (model !== undefined) return chooseModel({ model });

                    }}
                  />
                  {selectionFailed ? <span role="alert">{copy.selectionFailed}</span> : null}
                </>
              ) : props.loading && !browsed ? (
                <div className="maka-executor-picker-readiness" role="status">
                  <p>{copy.loading}</p>
                </div>
              ) : (
                <div className="maka-executor-picker-readiness">
                  <p>{browsed ? copy[browsed.readiness] : copy.unavailable}</p>
                  {browsed?.readiness === 'history_only' ? (
                    <Button label={copy.newTask} variant="ghost" size="sm" onClick={openNewTask} />
                  ) : (
                    <Button label={copy.manage} variant="ghost" size="sm" onClick={openSetup} />
                  )}
                </div>
              )}
            </section>
          </div>
        }
      >
        <Button
          label={triggerLabel}
          variant="ghost"
          size="sm"
          isDisabled={props.disabled || props.isReadOnly}
          tooltip={props.fixed ? copy.fixed : undefined}
          className="maka-model-switcher-trigger maka-executor-selector"
        >
          <ComposerModelLabel text={triggerLabel} />
        </Button>
      </Popover>
      {props.selection ? <ExecutorThinkingLevelSelector {...props} disabled={props.disabled || selecting} /> : props.nativeThinkingControl}
      {(selectedUnavailable || props.error) && (
        <span role="status" className="maka-executor-notice">
          {selected && selected.readiness !== 'ready' ? copy[selected.readiness] : copy.unavailable}
          {selected?.readiness === 'history_only' ? (
            <Button label={copy.newTask} variant="ghost" size="sm" onClick={openNewTask} />
          ) : (
            <>
              <Button label={copy.manage} variant="ghost" size="sm" onClick={openSetup} />
              <Button
                label={copy.retry}
                variant="ghost"
                size="sm"
                isDisabled={props.loading}
                onClick={props.onRetry}
              />
            </>
          )}
        </span>
      )}
    </>
  );
}


/** Same footer control as native thinking; external levels select exact model variants. */
export function ExecutorThinkingLevelSelector(props: ExecutorModelPickerProps) {
  const entry = props.catalog.find(candidate => candidate.id === props.selection?.executorId);
  const model = props.selection?.configuration.model ?? entry?.currentModel;
  const group = entry && executorModelGroup(entry, model);
  if (!props.selection || !entry || !group || group.variants.length < 2) return null;
  return <ThinkingLevelSelector
    levels={group.variants.map(variant => variant.level)}
    current={group.variants.find(variant => variant.modelId === model)?.level}
    includeDefault={false}
    confirmedOnly
    presentation={props.presentation === 'popover' ? 'popover' : props.presentation ? 'bottom-sheet' : undefined}
    isReadOnly={props.isReadOnly}
    disabled={props.disabled || entry.readiness !== 'ready' || (props.fixed && !entry.supportsModelChange)}
    onChange={async (level) => {
      const variant = group.variants.find(candidate => candidate.level === level);
      if (variant) await props.onSelect({ executorId: entry.id, configuration: { model: variant.modelId } });
    }}
  />;
}
