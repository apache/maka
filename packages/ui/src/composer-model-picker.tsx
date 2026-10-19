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
import { Button, Stack } from '@astryxdesign/core';
import { Selector, SelectorOption, type SelectorOptionType } from '@astryxdesign/core/Selector';
import type { ExecutorCatalogEntry, ExecutorConfiguration, ExecutorSelection } from '@maka/core/executor-catalog';
import type { ThinkingLevel } from '@maka/core/model-thinking';
import type { ProviderType } from '@maka/core/llm-connections';
import { type UiLocale, defineShippedUiMessageCatalog, resolveUiMessageCatalog } from '@maka/core/ui-locale';
import { Settings, ICON_SIZE } from './icons.js';
import { ComposerModelLabel } from './composer-model-label.js';
import { buildModelPickerOptions, providerMarkIcon, renderChatModelPickerOption } from './model-picker-internals.js';
import { exactModelChoiceValue, modelMenuGroups, type ChatModelChoice } from './chat-model-helpers.js';
import { executorModelGroup, highestExecutorModelVariant } from './executor-model-presentation.js';
import { useUiLocale } from './locale-context.js';
import { getSharedUiCopy } from './shared-ui-copy.js';
import { getConversationCopy } from './conversation-copy.js';
import { usePendingSelection } from './use-pending-selection.js';
import type { MakaClientExecutorTarget } from './client-plugin-slots.js';

export interface ComposerModelContribution {
  readonly id: string;
  readonly label: string;
  readonly models: readonly {
    readonly id: string;
    readonly label: string;
    readonly providerType?: ProviderType;
    readonly thinkingLevels: readonly ThinkingLevel[];
    readonly defaultThinkingLevel?: ThinkingLevel;
  }[];
  readonly loading: boolean;
  readonly error?: string;
  onLoad(): void;
}

export interface ComposerExecutorPicker {
  catalog: readonly ExecutorCatalogEntry[];
  selection?: ExecutorSelection;
  renderExecutorMark?(entry?: ExecutorCatalogEntry): ReactNode;
  fixed?: boolean;
  disabled?: boolean;
  loading?: boolean;
  error?: string;
  onSelect(selection: ExecutorSelection | undefined): void | Promise<void>;
  onSetup(executorId?: string): void;
  onRetry(): void;
  onNewTask(): void;
  onRestore?(): void | Promise<void>;
}

interface ExecutorCopy {
  nativeOperations: string;
  manage: string;
  signIn: string;
  default: string;
  unavailable: string;
  authentication_required: string;
  history_only: string;
  restorable: string;
  restoring: string;
  restore_failed: string;
  history_gap: string;
  restore: string;
  retry: string;
  newTask: string;
  selectionFailed: string;
  invalid: string;
  mode: string;
}

const EXECUTOR_COPY = resolveUiMessageCatalog(defineShippedUiMessageCatalog<ExecutorCopy>()({
  en: {
    nativeOperations: 'This operation requires Maka. Start a new Maka task.',
    manage: 'Manage external agents',
    signIn: 'Go to sign in',
    default: 'Agent default',
    unavailable: 'Unavailable. Check setup and retry.',
    authentication_required: 'Sign in from External Agents settings.',
    history_only:
      'The external process was lost. History is readable; start a new task to continue.',
    restorable: 'The external Session can be restored. Restore it before continuing.',
    restoring: 'Restoring the external Session…',
    restore_failed: 'Restoration failed. History is readable; retry or start a new task.',
    history_gap: 'The Agent may be ahead of saved history. Start a new task to avoid an incomplete transcript.',
    restore: 'Restore Session',
    retry: 'Retry',
    newTask: 'New task',
    selectionFailed: 'Model change failed. Try again.',
    invalid: 'The selected Agent configuration is no longer available. Choose again.',
    mode: 'Mode',
  },
  'zh-CN': {
    nativeOperations: '此操作仅支持 Maka。请新建 Maka 任务。',
    manage: '管理外部 Agent',
    signIn: '前往登录',
    default: 'Agent 默认',
    unavailable: '当前不可用，请检查设置后重试。',
    authentication_required: '需要登录，请前往外部 Agent 设置。',
    history_only: '外部进程已丢失。历史仍可阅读，请新建任务继续。',
    restorable: '外部会话可以恢复。请先恢复，再继续对话。',
    restoring: '正在恢复外部会话…',
    restore_failed: '恢复失败，历史仍可阅读。请重试或新建任务。',
    history_gap: 'Agent 的进度可能超出已保存历史。请新建任务，避免记录不完整。',
    restore: '恢复会话',
    retry: '重试',
    newTask: '新建任务',
    selectionFailed: '模型切换失败，请重试。',
    invalid: '所选 Agent 配置已失效，请重新选择。',
    mode: '模式',
  },
  'zh-TW': {
    nativeOperations: '此操作僅支援 Maka。請建立 Maka 任務。',
    manage: '管理外部 Agent',
    signIn: '前往登入',
    default: 'Agent 預設',
    unavailable: '目前無法使用，請檢查設定後重試。',
    authentication_required: '需要登入，請前往外部 Agent 設定。',
    history_only: '外部程序已遺失。歷史仍可閱讀，請建立新任務繼續。',
    restorable: '外部會話可以恢復。請先恢復，再繼續對話。',
    restoring: '正在恢復外部會話…',
    restore_failed: '恢復失敗，歷史仍可閱讀。請重試或建立新任務。',
    history_gap: 'Agent 的進度可能超出已儲存歷史。請建立新任務，避免記錄不完整。',
    restore: '恢復會話',
    retry: '重試',
    newTask: '建立新任務',
    selectionFailed: '模型切換失敗，請重試。',
    invalid: '所選 Agent 設定已失效，請重新選擇。',
    mode: '模式',
  },
}));

export function executorCopy(locale: UiLocale): ExecutorCopy {
  return EXECUTOR_COPY[locale];
}


const WARNING = '__maka_model_switch_warning__';
const DEFAULT_EFFORT = '__default__';
const nativeValue = (choice: ChatModelChoice) => exactModelChoiceValue(choice.connectionId, choice.connectionSlug, choice.model);
const externalValue = (entry: ExecutorCatalogEntry, model: string | undefined) => {
  const group = executorModelGroup(entry, model);
  return JSON.stringify([entry.id, group ? 'group:' + group.id : 'model:' + (model ?? '')]);
};

export function ThinkingLevelSelector(props: {
  levels: readonly ThinkingLevel[];
  current?: ThinkingLevel;
  includeDefault?: boolean;
  presentation?: 'popover' | 'bottom-sheet';
  isReadOnly?: boolean;
  disabled?: boolean;
  disabledReason?: string;
  onChange?(level: ThinkingLevel | undefined): void | Promise<void>;
}) {
  const copy = getConversationCopy(useUiLocale()).model;
  const selection = usePendingSelection(props.current ?? DEFAULT_EFFORT, value =>
    props.onChange?.(value === DEFAULT_EFFORT ? undefined : value as ThinkingLevel));
  if (!props.levels.length || !props.onChange) return null;
  return <Selector
    label={copy.thinkingLevel}
    isLabelHidden
    value={selection.value}
    options={[
      ...(props.includeDefault === false ? [] : [{ value: DEFAULT_EFFORT, label: copy.defaultLevel }]),
      ...props.levels.map(level => ({ value: level, label: copy.level[level] })),
    ]}
    variant="ghost" size="sm" placement="above"
    presentation={props.presentation}
    isReadOnly={props.isReadOnly}
    isDisabled={props.disabled}
    disabledMessage={props.disabledReason}
    className="maka-thinking-level-selector"
    onChange={selection.onChange}
  />;
}

/** One selection flow for native models and configured external agents. */
export function ComposerModelPicker(props: {
  label: string;
  choices: ChatModelChoice[];
  value?: string;
  onNativeChange?(choice: { llmConnectionId: string; llmConnectionSlug: string; model: string }): void | Promise<void>;
  renderThinkingControl?(pending: boolean): ReactNode;
  executor?: ComposerExecutorPicker;
  contribution?: ComposerModelContribution;
  executorTarget?: MakaClientExecutorTarget;
  onExecutorTargetChange?(target: MakaClientExecutorTarget): void | Promise<void>;
  presentation?: 'popover' | 'bottom-sheet';
  disabled?: boolean;
  disabledReason?: string;
  isReadOnly?: boolean;
  sessionId?: string;
  openNonce?: number;
  hasConversationHistory?: boolean;
  hideUnavailableCurrentOption?: boolean;
  renderProviderMark?(type: ProviderType): ReactNode;
  onOpenSettings?(): void;
  onPendingChange?(pending: boolean): void;
}) {
  const locale = useUiLocale();
  const modelCopy = getConversationCopy(locale).model;
  const searchCopy = getSharedUiCopy(locale).modelPicker;
  const copy = executorCopy(locale);
  const executor = props.executor;
  const contribution = props.contribution;
  const contributed = contribution?.id === props.executorTarget?.executorId ? contribution : undefined;
  const contributedModel = contributed?.models.find(model => model.id === props.executorTarget?.model);
  const selected = !contributed ? executor?.catalog.find(entry => entry.id === executor.selection?.executorId) : undefined;
  const selectedModel = executor?.selection?.configuration.model ?? selected?.currentModel;
  const group = selected && executorModelGroup(selected, selectedModel);
  const modelLabel = contributed ? contributedModel?.label ?? props.executorTarget?.model ?? copy.default : executor?.selection
    ? group?.name ?? selected?.models.find(model => model.id === selectedModel)?.name ?? selectedModel ?? copy.default
    : props.label;
  const label = !executor?.fixed && (contributed || executor?.selection)
    ? `${contributed?.label ?? selected?.displayName ?? executor?.selection?.executorId} · ${modelLabel}` : modelLabel;
  const authoritative = contributed ? JSON.stringify([contributed.id, props.executorTarget?.model ?? '']) : executor?.selection
    ? selected ? externalValue(selected, selectedModel) : JSON.stringify([executor.selection.executorId, selectedModel ?? ''])
    : props.value ?? (props.choices.length === 0 && !executor ? '__maka_model_display__' : '');
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [reopen, setReopen] = useState(false);
  useEffect(() => { if (reopen) setReopen(false); }, [reopen]);
  useEffect(() => { if (props.openNonce) contribution?.onLoad(); }, [props.openNonce, contribution?.onLoad]);
  useEffect(() => { props.onPendingChange?.(pending); }, [pending, props.onPendingChange]);
  useEffect(() => () => props.onPendingChange?.(false), [props.onPendingChange]);
  const disabled = props.disabled || executor?.disabled || pending;
  const commit = async (action: () => void | Promise<void>) => {
    if (disabled || props.isReadOnly) return;
    setPending(true);
    setFailed(false);
    try { await action(); } catch { setFailed(true); } finally { setPending(false); }
  };
  const options: SelectorOptionType[] = [];
  const actions = new Map<string, () => void | Promise<void>>();
  if (!executor?.fixed || !executor.selection) {
    options.push(...buildModelPickerOptions(
      modelMenuGroups(props.choices, locale), undefined, nativeValue, props.renderProviderMark,
    ));
    for (const choice of props.onNativeChange ? props.choices : []) actions.set(nativeValue(choice), () => props.onNativeChange?.({
      llmConnectionId: choice.connectionId, llmConnectionSlug: choice.connectionSlug, model: choice.model,
    }));
  }
  if (contribution && (!executor?.fixed || contributed)) {
    options.push({ type: 'section', title: contribution.label, options: contribution.models.map(model => {
      const value = JSON.stringify([contribution.id, model.id]);
      actions.set(value, () => props.onExecutorTargetChange?.({ executorId: contribution.id, model: model.id,
        ...(model.defaultThinkingLevel ? { thinkingLevel: model.defaultThinkingLevel } : {}) }));
      return { value, label: model.label, icon: providerMarkIcon(model.providerType, props.renderProviderMark) };
    }) });
  }
  for (const entry of executor?.catalog ?? []) {
    if (entry.id === contribution?.id) continue;
    if (executor?.fixed && entry.id !== executor.selection?.executorId) continue;
    options.push({
      type: 'section',
      title: entry.displayName,
      options: entry.readiness === 'ready' ? entry.models.flatMap(model => {
        const family = executorModelGroup(entry, model.id);
        if (family && entry.models.find(candidate => family.variants.some(variant => variant.modelId === candidate.id))?.id !== model.id) return [];
        const value = externalValue(entry, model.id);
        actions.set(value, () => executor?.onSelect({
          executorId: entry.id,
          configuration: { model: family ? highestExecutorModelVariant(family) : model.id },
        }));
        return [{
          value, label: family?.name ?? model.name,
          icon: providerMarkIcon(model.providerType, props.renderProviderMark) ?? executor?.renderExecutorMark?.(entry),
          disabled: !!executor?.fixed && !entry.supportsModelChange,
        }];
      }) : [{ value: JSON.stringify([entry.id, 'unavailable']), label: copy[entry.readiness], disabled: true }],
    });
  }
  if (authoritative && !actions.has(authoritative) && !props.hideUnavailableCurrentOption) {
    options.unshift({ value: authoritative, label, disabled: true });
  }
  const noticeShown = props.hasConversationHistory && !props.executorTarget && !executor?.selection && !acknowledged;
  if (noticeShown) options.unshift({ value: WARNING, label: modelCopy.switchWarning, description: modelCopy.switchWarningDismiss });
  const selection = usePendingSelection(authoritative, value => {
    const action = actions.get(value);
    if (action) return commit(action);
  });
  const unavailable = !contributed && !!executor?.selection && (selected ? selected.readiness !== 'ready' : !executor.loading);
  const invalid = !!selected && selected.readiness === 'ready' && (
    (!!selectedModel && !selected.models.some(model => model.id === selectedModel)) ||
    (!!executor?.selection?.configuration.mode && !selected.modes?.some(mode => mode.id === executor.selection?.configuration.mode))
  );
  const entryDisabled = !!executor?.fixed && !!selected && !selected.supportsModelChange;
  const displayOnly = !actions.size && !executor;
  const externalConfiguration = (configuration: ExecutorConfiguration) =>
    executor?.onSelect({ executorId: executor.selection!.executorId, configuration: executor.fixed || (configuration.model !== undefined && configuration.model !== selectedModel)
      ? configuration : { ...executor.selection!.configuration, ...configuration } });
  const mode = executor?.selection?.configuration.mode ?? selected?.currentMode;
  const recoveryEntries = executor?.selection
    ? selected && selected.readiness !== 'ready' ? [selected] : []
    : executor?.catalog.filter(entry => entry.readiness === 'authentication_required' || entry.readiness === 'unavailable') ?? [];
  return <>
    {/* Keep portaled search clicks from focusing the composer editor. */}
    <Stack direction="horizontal" className="maka-model-picker-root"
      onClick={event => { event.stopPropagation(); contribution?.onLoad(); }}
      onKeyDownCapture={event => { if (['Enter', ' ', 'ArrowDown', 'ArrowUp'].includes(event.key)) contribution?.onLoad(); }}>
      <Selector
        key={String(props.openNonce ?? 0) + ':' + String(acknowledged)}
        label={props.sessionId ? modelCopy.switchAriaLabel + ': ' + label : modelCopy.newChatAriaLabel(label)}
        isLabelHidden
        options={options}
        value={selection.value}
        hasSearch
        searchPlaceholder={searchCopy.searchPlaceholder}
        emptyText={searchCopy.empty}
        emptySearchText={searchCopy.noResults}
        variant="ghost" size="sm" placement="above"
        presentation={props.presentation}
        isReadOnly={props.isReadOnly || displayOnly}
        isLoading={executor?.loading || contribution?.loading}
        isDisabled={disabled || entryDisabled}
        disabledMessage={props.disabledReason}
        isDefaultOpen={!!props.openNonce || reopen}
        placeholder={label}
        className="maka-model-switcher-trigger"
        renderValue={() => <ComposerModelLabel text={label} />}
        renderOption={option => option.value === WARNING
          ? <SelectorOption className="modelPickerOption modelPickerChatOption modelPickerSwitchNotice" label={<span>{option.label}</span>} description={option.description} />
          : renderChatModelPickerOption(option)}
        onChange={value => {
          if (value === WARNING) { setReopen(true); setAcknowledged(true); return; }
          void selection.onChange(value);
        }}
      />
    </Stack>
    {contributed ? <ThinkingLevelSelector
      levels={contributedModel?.thinkingLevels ?? []}
      current={props.executorTarget?.thinkingLevel}
      presentation={props.presentation}
      isReadOnly={props.isReadOnly}
      disabled={disabled}
      onChange={thinkingLevel => commit(() => props.onExecutorTargetChange?.({
        executorId: contributed.id, model: props.executorTarget?.model, ...(thinkingLevel ? { thinkingLevel } : {}),
      }))}
    /> : executor?.selection ? group && <ThinkingLevelSelector
      levels={group.variants.map(variant => variant.level)}
      current={group.variants.find(variant => variant.modelId === selectedModel)?.level}
      includeDefault={false}
      presentation={props.presentation}
      isReadOnly={props.isReadOnly}
      disabled={disabled || unavailable || entryDisabled}
      onChange={level => {
        const variant = group.variants.find(candidate => candidate.level === level);
        if (variant) return commit(() => externalConfiguration({ model: variant.modelId }));
      }}
    /> : props.renderThinkingControl?.(pending)}
    {executor?.selection && selected?.readiness === 'ready' && !!selected.modes?.length && <Selector
      label={copy.mode} isLabelHidden
      options={selected.modes.map(item => ({ value: item.id, label: item.name }))}
      value={mode} placeholder={copy.default}
      variant="ghost" size="sm" placement="above"
      presentation={props.presentation}
      isReadOnly={props.isReadOnly}
      isDisabled={disabled || (!!executor.fixed && !selected.supportsModeChange)}
      className="maka-executor-mode-selector"
      onChange={value => { void commit(() => externalConfiguration({ mode: value })); }}
    />}
    {executor && !executor.fixed && <Button label={copy.manage} tooltip={copy.manage}
      variant="ghost" size="sm" isIconOnly icon={<Settings size={ICON_SIZE.control} />}
      onClick={() => executor.onSetup()} />}
    {!executor && !actions.size && props.onOpenSettings && <Button
      label={modelCopy.configureTitle} variant="ghost" size="sm"
      icon={<Settings size={ICON_SIZE.control} />} onClick={props.onOpenSettings} />}
    {recoveryEntries.map(entry => <span key={entry.id} className="maka-executor-notice" role="status">
      {entry.displayName + ': ' + copy[entry.readiness as Exclude<typeof entry.readiness, 'ready'>]}
      {executor && (entry.readiness === 'restorable' || entry.readiness === 'restore_failed') ? <Button
        label={copy.restore} variant="ghost" size="sm" isDisabled={pending || !executor.onRestore}
        onClick={() => { if (executor.onRestore) void commit(executor.onRestore); }} />
        : executor && (entry.readiness === 'history_only' || entry.readiness === 'history_gap') ? <Button
          label={copy.newTask} variant="ghost" size="sm" onClick={executor.onNewTask} />
        : executor && entry.readiness === 'authentication_required' ? <Button
          label={copy.signIn} variant="ghost" size="sm" onClick={() => executor.onSetup(entry.id)} />
        : executor && entry.readiness !== 'restoring' ? <Button
          label={copy.retry} variant="ghost" size="sm" isLoading={executor.loading} onClick={executor.onRetry} />
        : null}
    </span>)}
    {(failed || invalid || executor?.error || (unavailable && !selected) || contribution?.error) && <span className="maka-executor-notice" role="status">
      {contribution?.error ? contribution.label + ': ' + copy.unavailable : unavailable && !selected ? copy.unavailable : invalid ? copy.invalid : copy.selectionFailed}
      {contribution?.error && <Button label={copy.retry} variant="ghost" size="sm" isLoading={contribution.loading} onClick={contribution.onLoad} />}
      {executor && !contribution?.error && <Button label={copy.retry} variant="ghost" size="sm" isLoading={executor.loading} onClick={executor.onRetry} />}
    </span>}
  </>;
}
