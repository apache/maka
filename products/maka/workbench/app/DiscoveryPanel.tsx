/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements. See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership. The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License. You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied. See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */
import { cleanup, platform, signal, Text, View, Scroll, windowSize } from 'nsh';
import { Button } from 'nsh/base';
import type {
  AgentScheduledDetail,
  AgentScheduledSummary,
  DiscoveryToolGroup,
  IntervalCadence,
  ModelSelection,
  ThinkingLevel,
  SettingsModelChoice,
} from '../../../../packages/plugin-sdk/src/index.js';
import type { Host } from './host';
import { currentLocale, tr, type MessageKey } from './locale';
import { createText, errorText, UiError, renderText, message } from './text';
import {
  approvedDiscoveryNames,
  selectedDiscoveryTools,
  type DiscoveryToolPreview,
  type DiscoveryToolSelection,
  discoveryCadence,
  discoveryInput,
  discoveryIntervalError,
  discoveryTasks,
  discoveryWorkerTools,
  type DiscoveryApproval,
  type DiscoveryWorkerTools,
} from './discoveryCore';
import {
  DiscoveryToolPicker,
  discoverySelectionLabel,
  discoveryExternalToolNotice,
} from './DiscoveryToolPicker';
import { Icon } from './Icon';
import { SettingsEditor } from './SettingsField';
import { SettingsButton, SettingsInlineInput, SettingsSelect } from './SettingsPage';
import { DialogFooter, DialogHeader, ModalDialog } from './ModalDialog';
import { LoadingIndicator } from './Loading';
import { readSettingsModels, settingsModelKey } from './settings';
import { accessLabel } from './SessionPermissionsSelect';
import { C, bodyTextStyle, captionTextStyle, toolbarControlStyle, textTooltip } from './ui';
import { sameValue } from '../../../../plugins/shared/value';
import { nativeModelSelection } from './modelSelection';

type Props = {
  host: Host;
  sessionId: string;
  control(method: string, input: unknown): Promise<any>;
  openWorker(id: string): void;
  chooseModel(): void;
};

const formRow = {
  flexDirection: 'row',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 12,
} as const;
const formDivider = () => ({ borderTopWidth: 1, borderTopColor: C.line, paddingTop: 14, gap: 8 });
const formLabel = () => ({ ...bodyTextStyle, color: C.text, flexShrink: 1 });

function DiscoveryModelField(props: {
  host: Host;
  model: ModelSelection | null;
  verified: SettingsModelChoice | null;
  disabled: boolean;
  change(choice: SettingsModelChoice): void;
  configure(): void;
}) {
  const choices = signal<SettingsModelChoice[]>([]);
  const loading = signal(true),
    failure = signal('');
  let alive = true;
  cleanup(() => {
    alive = false;
  });
  const load = async () => {
    loading.set(true);
    failure.set('');
    try {
      const result = await readSettingsModels(props.host, () => alive);
      if (alive && result) choices.set(result.choices);
    } catch (reason) {
      if (alive) failure.set(renderText(errorText(reason, 'Could not load models.')));
    } finally {
      if (alive) loading.set(false);
    }
  };
  void load();
  const key = () => (props.model ? settingsModelKey(props.model) : null);
  const current = () =>
    props.verified && settingsModelKey(props.verified.selection) === key()
      ? props.verified
      : choices().find((choice) => settingsModelKey(choice.selection) === key());
  return (
    <View style={{ gap: 2 }}>
      <SettingsSelect
        flush
        label={tr('Discovery model')}
        value={key()}
        choices={choices().map((choice) => ({
          value: settingsModelKey(choice.selection),
          title: choice.label,
          group: choice.connectionName,
        }))}
        placeholder={
          current()?.label ??
          (loading()
            ? tr('Loading…')
            : props.model
              ? tr('{model} · Unavailable', { model: props.model.modelId })
              : tr('Choose a model'))
        }
        change={(value) => {
          const choice = choices().find((item) => settingsModelKey(item.selection) === value);
          if (choice) props.change(choice);
        }}
        disabled={props.disabled || !choices().length}
      />
      <If when={current()}>
        {(choice) => (
          <Text style={{ ...captionTextStyle, color: C.muted, textAlign: 'right' }}>
            {choice().connectionName}
          </Text>
        )}
      </If>
      <If when={failure()}>
        <Text style={{ ...captionTextStyle, color: C.danger }}>{failure()}</Text>
        <SettingsButton label={tr('Retry')} tone="quiet" onPress={() => void load()} />
      </If>
      <If when={!loading() && !failure() && !choices().length}>
        <SettingsButton
          label={tr('Change discovery model')}
          tone="quiet"
          onPress={props.configure}
        />
      </If>
    </View>
  );
}

export function DiscoveryPanel(props: { open(): void }) {
  return (
    <Button
      accessibilityLabel={tr('Proactive discovery')}
      tooltip={textTooltip(() => tr('Proactive discovery'))}
      style={{ ...toolbarControlStyle, flexDirection: 'row', gap: 6, alignItems: 'center' }}
      onPress={props.open}
      hoverStyle={{ backgroundColor: C.card }}
    >
      <Icon name="activity" color={C.secondary} />
      <Text style={{ ...captionTextStyle, color: C.secondary }}>{tr('Proactive discovery')}</Text>
    </Button>
  );
}

export function DiscoveryDialog(props: Props & { close(): void }) {
  const timeFormat = new Intl.DateTimeFormat(currentLocale(), {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
    timeZoneName: 'short',
  });
  const tasks = signal<AgentScheduledSummary[]>([]),
    selected = signal<string | null>(null);
  const showFollowups = signal(false);
  const visibleTasks = () =>
    showFollowups()
      ? tasks()
      : tasks().filter((task) => !task.backgroundFollowup || task.id === selected());
  const detail = signal<AgentScheduledDetail | null>(null),
    basis = signal<DiscoveryApproval | null>(null);
  const loading = signal(true),
    busy = signal(false),
    editing = signal(false),
    watching = signal(false);
  // Editing is based on the revision the user opened, not a later watch update.
  const editingPlan = signal<AgentScheduledDetail | null>(null);
  const minutes = signal('30'),
    intent = signal('');
  const cadence = signal<IntervalCadence>(discoveryCadence());
  const workerTools = signal<DiscoveryWorkerTools>('read_only');
  const toolPreview = signal<DiscoveryToolPreview | null>(null);
  const formModel = signal<Pick<DiscoveryApproval, 'model' | 'thinkingLevel'> | null>(null);
  const formTarget = signal<DiscoveryApproval['target'] | null>(null);
  const formChoice = signal<SettingsModelChoice | null>(null);
  const intervalError = () =>
    discoveryIntervalError(Number(minutes()), editingPlan()?.task.schedule);
  const selectedTools = signal<DiscoveryToolSelection>({});
  let initialToolSelection: DiscoveryToolSelection | undefined;
  let openedToolPreview = false;
  // Keep explicit choices even while their group is absent from the active preset.
  const draftGroups = new Map<DiscoveryToolGroup, ReadonlySet<string>>();
  const reapproving = signal(false);
  const deleting = signal(false);
  const needsRenewedApproval = (plan = detail()) =>
    !!plan && !plan.approved && plan.task.lastError === 'scheduler_authorization_changed';
  const wasApproved = (plan: AgentScheduledDetail | null) =>
    !!plan?.approved || needsRenewedApproval(plan);
  const resolvedWorkerTools = () => discoveryWorkerTools(detail()?.task.effect);
  const error = createText();
  const watchError = createText();
  const planSelection = (plan = detail()) => {
    const effect = plan?.task.effect;
    return effect?.kind === 'discovery' ? effect.selectedTools : undefined;
  };
  const unavailableEditTarget = () => {
    const plan = editingPlan();
    if (!plan) return false;
    const current = tasks().find((task) => task.id === plan.task.id);
    return current?.status !== 'active' && current?.status !== 'paused';
  };
  const modelLabel = signal('');
  let displayedModel = '';
  const describeModel = async (model: ModelSelection) => {
    const key = JSON.stringify(model);
    if (displayedModel === key) return;
    displayedModel = key;
    modelLabel.set(model.modelId);
    const resolved = await props.host.query('settings', 'resolveModel', model);
    if (alive && displayedModel === key && resolved.kind === 'ready')
      modelLabel.set(`${resolved.choice.label} · ${resolved.choice.connectionName}`);
  };
  let alive = true,
    generation = 0,
    formGeneration = 0;
  let stream: { next(): Promise<any>; close(): Promise<void> } | null = null;
  cleanup(() => {
    alive = false;
    generation++;
    void stream?.close().catch(() => {});
  });
  const capture = async (ticket = formGeneration): Promise<DiscoveryApproval> => {
    const { session, rememberedBackend } = await props.host.query('agent', 'observe', {
      sessionId: props.sessionId,
    });
    const target = {
      sessionId: session.id,
      workspace: session.workspace,
      permissions: session.permissions,
      boundaryRevision: session.boundaryRevision,
      binding: session.binding,
    };
    if (alive && editing() && ticket === formGeneration) formTarget.set(target);
    let chosen = formModel();
    if (!chosen) {
      const backend = session.backend ?? rememberedBackend;
      if (backend?.kind !== 'model') throw new UiError('This action requires a native model.');
      const available = await props.host.query('agent', 'model', { backend });
      if (available.kind !== 'ready')
        throw new UiError('Model unavailable: {model}. Choose another model.', {
          model: backend.modelId,
        });
      chosen = {
        model: nativeModelSelection(backend),
        thinkingLevel: backend.thinkingLevel ?? null,
      };
    }
    const resolved = await props.host.query('settings', 'resolveModel', chosen.model);
    if (alive && ticket === formGeneration)
      formChoice.set(resolved.kind === 'ready' ? resolved.choice : null);
    if (resolved.kind !== 'ready')
      throw new UiError('Model unavailable: {model}. Choose another model.', {
        model: chosen.model.modelId,
      });
    return { target, ...chosen };
  };
  const readDetail = async (id: string) => {
    const ticket = ++generation;
    const value = await props.host.query('agent', 'schedules', { kind: 'get', taskId: id });
    if (!alive || selected() !== id || ticket !== generation) return;
    if (
      value.kind !== 'task' ||
      !value.detail ||
      value.detail.task.effect.kind !== 'discovery' ||
      value.detail.task.effect.target.sessionId !== props.sessionId
    )
      throw new UiError('Discovery plan changed');
    detail.set(value.detail);
    if (!editing()) await describeModel(value.detail.task.effect.model);
  };
  const select = async (id: string) => {
    if (busy()) return;
    formGeneration++;
    selected.set(id);
    editing.set(false);
    deleting.set(false);
    detail.set(null);
    error.set('');
    try {
      await readDetail(id);
    } catch (reason) {
      if (alive) error.set(errorText(reason, 'Could not load the discovery plan.'));
    }
  };
  const previewTools = async (
    captured: DiscoveryApproval,
    profile: DiscoveryWorkerTools,
    ticket: number,
    mode: 'draft' | 'refresh',
  ): Promise<boolean> => {
    toolPreview.set(null);
    try {
      const result = await props.host.query('agent', 'schedules', {
        kind: 'preview_discovery',
        effect: { kind: 'discovery', ...captured, workerTools: profile },
        taskId: editingPlan()?.task.id ?? null,
      });
      if (!alive || ticket !== formGeneration) return false;
      if (result.kind !== 'discovery_tools') throw new UiError('Discovery plan changed');
      if (!openedToolPreview && result.approvedNames != null) {
        initialToolSelection = selectedDiscoveryTools(
          result,
          planSelection(editingPlan()),
          result.approvedNames,
        );
      }
      selectedTools.set(
        mode === 'refresh'
          ? selectedDiscoveryTools(result, selectedTools())
          : selectedDiscoveryTools(result, initialToolSelection, undefined, draftGroups),
      );
      openedToolPreview = true;
      toolPreview.set(result);
      return true;
    } catch (reason) {
      if (alive && ticket === formGeneration)
        error.set(errorText(reason, 'Could not load the discovery plan.'));
      return false;
    }
  };
  const changeToolGroup = (group: DiscoveryToolGroup, selection: DiscoveryToolSelection) => {
    const names = Object.keys(selection).filter((name) => selection[name] === group);
    draftGroups.set(group, new Set(names));
    selectedTools.set(selection);
  };
  const changeWorkerTools = (value: string) => {
    const profile = value === 'session' ? 'session' : 'read_only';
    if (workerTools() === profile) return;
    workerTools.set(profile);
    const captured = basis();
    if (captured) {
      error.set('');
      void previewTools(captured, profile, ++formGeneration, 'draft');
    }
  };
  const refreshDraftModel = async (ticket: number) => {
    basis.set(null);
    toolPreview.set(null);
    error.set('');
    try {
      const captured = await capture(ticket);
      if (!alive || ticket !== formGeneration) return;
      basis.set(captured);
      await previewTools(captured, workerTools(), ticket, 'draft');
    } catch (reason) {
      if (alive && ticket === formGeneration)
        error.set(errorText(reason, 'Could not load the discovery plan.'));
    }
  };
  const changeDraftModel = (choice: SettingsModelChoice) => {
    if (busy()) return;
    const from = formModel() ?? basis();
    const level = from?.thinkingLevel;
    formModel.set({
      model: choice.selection,
      thinkingLevel:
        level && (choice.thinkingLevels as readonly ThinkingLevel[]).includes(level) ? level : null,
    });
    void refreshDraftModel(++formGeneration);
  };
  const edit = async (fresh: boolean, approve = false) => {
    const plan = fresh ? null : detail();
    if (busy() || (!fresh && !plan)) return;
    const ticket = ++formGeneration;
    draftGroups.clear();
    openedToolPreview = false;
    editingPlan.set(plan);
    reapproving.set(approve);
    deleting.set(false);
    const effect = plan?.task.effect;
    const renewing = wasApproved(plan);
    const profile = renewing ? discoveryWorkerTools(effect) : 'read_only';
    // Only a first approval starts from preset defaults. A lost grant starts with no optional tools.
    initialToolSelection = planSelection(plan) ?? (renewing ? {} : undefined);
    workerTools.set(profile);
    toolPreview.set(null);
    selectedTools.set(initialToolSelection ?? {});
    intent.set(plan?.task.intent.body ?? '');
    const schedule = plan?.task.schedule;
    minutes.set(schedule?.kind === 'interval' ? String(schedule.everySeconds / 60) : '30');
    cadence.set(discoveryCadence(schedule));
    editing.set(true);
    formChoice.set(null);
    formTarget.set(effect?.kind === 'discovery' ? effect.target : null);
    formModel.set(
      effect?.kind === 'discovery'
        ? { model: effect.model, thinkingLevel: effect.thinkingLevel ?? null }
        : null,
    );
    await refreshDraftModel(ticket);
  };
  const selectDefault = async () => {
    const visible = visibleTasks();
    const first = visible.find((plan) => plan.approved && plan.status === 'active') ?? visible[0];
    if (first) return select(first.id);
    generation++;
    formGeneration++;
    selected.set(null);
    detail.set(null);
    editing.set(false);
    editingPlan.set(null);
    deleting.set(false);
    error.set('');
    if (!tasks().length) await edit(true);
  };
  const watch = async () => {
    if (watching()) return;
    watching.set(true);
    watchError.set('');
    try {
      const opened = await props.host.subscribe('agent', 'watchSchedules', {
        kind: 'discovery',
        sessionId: props.sessionId,
      });
      if (!alive) {
        await opened.close();
        return;
      }
      stream = opened;
      for (;;) {
        const page = await opened.next();
        if (!alive || page === null) break;
        try {
          const rows = await discoveryTasks(page, (cursor, expectedRevision) =>
            props.host.query('agent', 'schedules', {
              kind: 'discovery',
              sessionId: props.sessionId,
              cursor,
              expectedRevision,
            }),
          );
          if (!alive) return;
          tasks.set(rows);
          loading.set(false);
          const id = selected();
          if (id && rows.some((row) => row.id === id)) {
            await readDetail(id);
          } else if (!editing() && !busy()) {
            await selectDefault();
          } else if (id) {
            generation++;
            detail.set(null);
          }
          watchError.set('');
        } catch (reason) {
          if (alive) watchError.set(errorText(reason, 'Could not load the discovery plan.'));
        }
      }
      if (alive) watchError.set(message('Discovery updates disconnected'));
    } catch (reason) {
      if (alive) watchError.set(errorText(reason, 'Could not load the discovery plan.'));
    } finally {
      const opened = stream;
      stream = null;
      await opened?.close().catch(() => {});
      if (alive) {
        loading.set(false);
        watching.set(false);
      }
    }
  };
  void watch();
  const change = async (action: 'pause' | 'resume' | 'trigger_now' | 'delete') => {
    const current = detail();
    if (!current || busy()) return;
    busy.set(true);
    error.set('');
    let deleted = false;
    try {
      const result = await props.control('schedule', {
        kind: action,
        taskId: current.task.id,
        revision: current.revision,
      });
      if (result.kind === 'conflict') throw new UiError('Discovery plan changed');
      if (result.kind === 'rejected') {
        if (
          alive &&
          action === 'resume' &&
          [
            'scheduler_authorization_changed',
            'background_model_route_changed',
            'scheduler_user_approval_required',
            'agent_model_unavailable',
            'agent_authentication_required',
            'agent_workspace_unavailable',
          ].includes(result.reason)
        ) {
          busy.set(false);
          await edit(false, true);
          return;
        }
        throw new Error(result.reason);
      }
      if (alive && action === 'delete') {
        tasks.set(tasks().filter((task) => task.id !== current.task.id));
        selected.set(null);
        detail.set(null);
        deleting.set(false);
        deleted = true;
      } else if (alive) {
        await readDetail(current.task.id);
      }
    } catch (reason) {
      if (alive) error.set(errorText(reason, 'Could not update the discovery plan.'));
    } finally {
      if (alive) busy.set(false);
    }
    if (deleted && alive) await selectDefault();
  };
  const save = async () => {
    const captured = basis(),
      preview = toolPreview();
    if (!captured || !preview || busy() || unavailableEditTarget()) return;
    const current = editingPlan(),
      id = current?.task.id;
    let input;
    try {
      input = discoveryInput(
        captured,
        current?.task.title ?? tr('Proactive discovery'),
        intent(),
        Number(minutes()),
        Date.now(),
        timeFormat.resolvedOptions().timeZone ?? 'UTC',
        current,
        { cadence: cadence(), workerTools: workerTools() },
      );
      const chosen = selectedTools();
      input.approvedTools = approvedDiscoveryNames(preview, chosen);
      // Keep an unchanged preset grant (and its one-time follow-ups) on timing-only edits.
      const keepPresetGrant =
        current?.approved &&
        !reapproving() &&
        sameValue(current.task.effect, input.task.effect) &&
        sameValue(input.approvedTools, preview.approvedNames);
      if (input.task.effect.kind === 'discovery' && !keepPresetGrant) {
        input.task.effect.selectedTools = chosen;
      }
    } catch {
      error.set(message('Discovery invalid settings'));
      return;
    }
    busy.set(true);
    error.set('');
    try {
      const latest = await capture();
      if (!alive) return;
      if (!sameValue(latest, captured)) {
        basis.set(latest);
        if (await previewTools(latest, workerTools(), ++formGeneration, 'refresh'))
          throw new UiError('Discovery settings changed');
        return;
      }
      const result = await props.control(
        'schedule',
        id && current
          ? {
              kind: reapproving() ? 'approve' : 'update',
              taskId: id,
              revision: current.revision,
              input,
            }
          : { kind: 'create', input },
      );
      if (!alive) return;
      if (result.kind === 'conflict') throw new UiError('Discovery plan changed');
      if (result.kind === 'rejected') {
        if (result.reason === 'scheduler_authorization_changed') {
          const ticket = ++formGeneration;
          const refreshed = await capture(ticket);
          if (!alive) return;
          basis.set(refreshed);
          if (await previewTools(refreshed, workerTools(), ticket, 'refresh'))
            throw new UiError('Discovery settings changed');
          return;
        }
        if (result.reason === 'scheduler_discovery_tools_changed') {
          if (await previewTools(latest, workerTools(), ++formGeneration, 'refresh'))
            throw new UiError('Discovery tool catalog changed');
          return;
        }
        throw new Error(result.reason);
      }
      if (selected() !== result.taskId) detail.set(null);
      selected.set(result.taskId);
      editing.set(false);
      await readDetail(result.taskId);
    } catch (reason) {
      if (alive) error.set(errorText(reason, 'Could not update the discovery plan.'));
    } finally {
      if (alive) busy.set(false);
    }
  };
  const state = (): MessageKey => {
    const current = detail();
    if (!current) return 'Discovery not enabled';
    const phase = current.investigation?.phase;
    if (phase)
      return {
        investigating: 'Discovery investigating',
        delivering: 'Discovery delivering',
        stopping: 'Discovery stopping',
      }[phase] as MessageKey;
    if (current.pendingFire) return 'Discovery queued';
    if (current.task.status === 'completed') return 'Discovery plan completed';
    if (current.task.status === 'expired') return 'Discovery plan expired';
    if (needsRenewedApproval(current)) return 'Discovery needs renewed approval';
    if (!current.approved) return 'Discovery needs approval';
    return current.task.status === 'active' ? 'Discovery active' : 'Discovery paused';
  };
  const snapshot = () => {
    const effect = detail()?.task.effect;
    return effect?.kind === 'discovery' ? effect : null;
  };
  const last = () => detail()?.task.runs[0];
  const editablePlan = () => {
    const status = detail()?.task.status;
    return status === 'active' || status === 'paused';
  };
  const time = (at: number | null | undefined) => (at == null ? '—' : timeFormat.format(at));
  const outcome = (): MessageKey =>
    last()?.outcome === 'failed'
      ? 'Discovery failed'
      : last()?.outcome === 'blocked'
        ? 'Discovery blocked'
        : last()?.message === 'No report'
          ? 'Discovery no report'
          : 'Discovery reported';
  const nextCheck = () => {
    const plan = detail();
    if (plan?.task.status !== 'active' || !plan.approved) return '—';
    return plan.pendingFire ? tr('Discovery next check pending') : time(plan.task.nextFireAt);
  };
  const worker = () => detail()?.investigation?.sessionId ?? last()?.sessionId;
  const cancel = () => {
    if (busy()) return;
    if (editing() && tasks().length) {
      if (selected() && tasks().some((task) => task.id === selected())) void select(selected()!);
      else void selectDefault();
    } else props.close();
  };
  const toggleFollowups = async () => {
    showFollowups.set(!showFollowups());
    if (
      !showFollowups() &&
      tasks().some((task) => task.id === selected() && task.backgroundFollowup)
    ) {
      selected.set(null);
    }
    if (!selected()) await selectDefault();
  };
  const action = (label: MessageKey, onPress: () => void, disabled = false) => (
    <SettingsButton
      label={tr(label)}
      onPress={onPress}
      disabled={busy() || disabled}
      tone="quiet"
    />
  );
  return (
    <ModalDialog
      size="form"
      onCancel={cancel}
      style={
        editing() && platform.idiom !== 'terminal'
          ? { maxWidth: 552, paddingHorizontal: 24, paddingVertical: 20, gap: 16 }
          : {}
      }
    >
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
        }}
      >
        <If when={editing()} else={<DialogHeader title={tr('Discovery plans')} />}>
          <Text
            role="header"
            style={{
              color: C.text,
              fontSize: platform.idiom === 'terminal' ? 14 : 20,
              lineHeight: platform.idiom === 'terminal' ? 16 : 28,
              fontWeight: '600',
            }}
          >
            {tr(editingPlan() ? 'Edit discovery plan title' : 'New discovery plan title')}
          </Text>
        </If>
        <If when={!editing() && tasks().length > 0}>
          <SettingsButton
            label={tr('New discovery plan')}
            icon="plus"
            tone="quiet"
            disabled={busy()}
            onPress={() => void edit(true)}
          />
        </If>
      </View>
      <Scroll style={{ minHeight: 0, flexShrink: 1 }} contentStyle={{ gap: 12, paddingRight: 4 }}>
        <If when={loading()}>
          <LoadingIndicator label={tr('Loading…')} color={C.muted} />
        </If>
        <If when={!editing() && visibleTasks().length > 1}>
          <SettingsSelect
            label={tr('Discovery plan')}
            value={selected()}
            choices={visibleTasks().map((task) => ({ value: task.id, title: task.title }))}
            disabled={busy()}
            change={(id) => void select(id)}
          />
        </If>
        <If when={!editing() && tasks().some((task) => task.backgroundFollowup)}>
          {action(
            showFollowups() ? 'Hide background follow-ups' : 'View background follow-ups',
            () => void toggleFollowups(),
          )}
        </If>
        <If when={!editing() && detail() !== null}>
          <View style={{ padding: 10, borderRadius: 8, backgroundColor: C.background, gap: 6 }}>
            <Text style={{ ...bodyTextStyle, color: C.text, fontWeight: '500' }}>
              {tr(state())}
            </Text>
            <Text style={{ ...captionTextStyle, color: C.secondary }}>
              {tr('Discovery next check')}: {nextCheck()}
            </Text>
            <Text style={{ ...captionTextStyle, color: C.secondary }}>
              {tr('Discovery last check')}:{' '}
              {last() ? time(last()?.at) + ' · ' + tr(outcome()) : tr('Discovery no history')}
            </Text>
            <If when={detail()!.task.lastError && !needsRenewedApproval()}>
              <Text style={{ ...captionTextStyle, color: C.danger, userSelect: 'text' }}>
                {detail()!.task.lastError}
              </Text>
            </If>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 4 }}>
              <If when={worker()}>
                {(id) =>
                  action(
                    detail()?.pendingFire && !detail()?.investigation
                      ? 'Open previous investigation'
                      : 'Open investigation',
                    () => props.openWorker(id()),
                  )
                }
              </If>
              <If when={editablePlan()}>
                {action(
                  'Edit discovery plan',
                  () => void edit(false, !detail()!.approved),
                  !!detail()!.pendingFire,
                )}
              </If>
              {action('Delete', () => deleting.set(true), !!detail()!.pendingFire)}
              <If when={detail()!.task.status === 'active'}>
                {action('Pause discovery', () => void change('pause'))}
              </If>
            </View>
          </View>
        </If>
        <If when={!editing() && snapshot() !== null}>
          <View style={{ gap: 4 }}>
            <Text style={{ ...captionTextStyle, color: C.secondary, userSelect: 'text' }}>
              {tr('Discovery workspace')}: {snapshot()!.target.workspace.path}
            </Text>
            <Text style={{ ...captionTextStyle, color: C.secondary }}>
              {tr('Discovery permissions')}:{' '}
              {resolvedWorkerTools() === 'session'
                ? tr('Use standard Session tools') + ' · ' + accessLabel('read_only')
                : tr('Use read-only investigation tools')}
            </Text>
            <If when={planSelection() != null}>
              <Text style={{ ...captionTextStyle, color: C.secondary }}>
                {discoverySelectionLabel(planSelection()!)}
              </Text>
            </If>
            <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
              <Text style={{ ...captionTextStyle, color: C.secondary, flexShrink: 1 }}>
                {tr('Discovery model')}: {modelLabel()}
              </Text>
            </View>
          </View>
        </If>
        <If when={editing()}>
          <View style={{ gap: 12 }}>
            <View style={{ gap: 6 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <Text style={formLabel()}>{tr('Discovery direction')}</Text>
                <Text style={{ ...captionTextStyle, color: C.muted }}>{tr('Optional')}</Text>
              </View>
              <View style={{ height: platform.idiom === 'terminal' ? 40 : 56 }}>
                <SettingsEditor
                  label={tr('Discovery instructions')}
                  placeholder={tr('Discovery broad placeholder')}
                  value={intent()}
                  change={intent.set}
                  disabled={busy()}
                />
              </View>
            </View>
            <If
              when={!editingPlan() || editingPlan()!.task.schedule.kind === 'interval'}
              else={
                <Text style={{ ...captionTextStyle, color: C.secondary }}>
                  {tr('Discovery existing schedule')}
                </Text>
              }
            >
              <SettingsSelect
                flush
                label={tr('Discovery schedule')}
                value={cadence()}
                choices={[
                  { value: 'after_completion', title: tr('Discovery after completion') },
                  { value: 'fixed', title: tr('Discovery fixed interval') },
                ]}
                change={(value) => cadence.set(value === 'fixed' ? 'fixed' : 'after_completion')}
                disabled={busy()}
                trailing={
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                    <View style={{ width: 64, height: platform.idiom === 'terminal' ? 16 : 28 }}>
                      <SettingsInlineInput
                        label={tr('Discovery interval (minutes)')}
                        value={minutes()}
                        change={minutes.set}
                        disabled={busy()}
                      />
                    </View>
                    <Text style={{ ...captionTextStyle, color: C.secondary }}>
                      {tr('Discovery minutes')}
                    </Text>
                  </View>
                }
              />
              <If when={intervalError()}>
                {(reason) => (
                  <Text style={{ ...captionTextStyle, color: C.danger }}>
                    {tr(
                      reason() === 'too_long'
                        ? 'Discovery interval too long'
                        : 'Discovery invalid settings',
                    )}
                  </Text>
                )}
              </If>
            </If>
          </View>
          <View style={formDivider()}>
            <View style={formRow}>
              <Text style={formLabel()}>{tr('Workspace')}</Text>
              <Text
                style={{
                  ...captionTextStyle,
                  flexShrink: 1,
                  textAlign: 'right',
                  color: C.secondary,
                  userSelect: 'text',
                }}
              >
                {formTarget()?.workspace.path ?? '—'}
              </Text>
            </View>
            <DiscoveryModelField
              host={props.host}
              model={formModel()?.model ?? basis()?.model ?? null}
              verified={formChoice()}
              disabled={busy()}
              change={changeDraftModel}
              configure={() => {
                props.close();
                props.chooseModel();
              }}
            />
          </View>
          <View style={formDivider()}>
            <View style={{ ...formRow, flexWrap: 'wrap' }}>
              <Text style={formLabel()}>{tr('Discovery permissions')}</Text>
              <View
                style={{
                  flexDirection: 'row',
                  gap: 2,
                  padding: 2,
                  backgroundColor: C.background,
                  borderRadius: 8,
                }}
              >
                <Each of={['read_only', 'session'] as const}>
                  {(profile) => (
                    <SettingsButton
                      label={tr(
                        profile() === 'read_only'
                          ? 'Use read-only investigation tools'
                          : 'Use standard Session tools',
                      )}
                      selected={workerTools() === profile()}
                      tone={workerTools() === profile() ? undefined : 'quiet'}
                      disabled={busy() || !basis()}
                      onPress={() => changeWorkerTools(profile())}
                    />
                  )}
                </Each>
              </View>
            </View>
            <If when={toolPreview() !== null}>
              <DiscoveryToolPicker
                preview={toolPreview()!}
                selection={selectedTools()}
                change={changeToolGroup}
                disabled={busy()}
              />
            </If>
            <If when={workerTools() === 'session' && formTarget()}>
              <Text style={{ ...captionTextStyle, color: C.muted }}>
                {tr('Discovery workspace scope', {
                  access: accessLabel('read_only'),
                })}
                {' ' + discoveryExternalToolNotice(selectedTools())}
              </Text>
            </If>
            <If when={toolPreview() && Object.values(selectedTools()).includes('read_files')}>
              <Text style={{ ...captionTextStyle, color: C.muted }}>
                {tr('Discovery Read scope')}
              </Text>
            </If>
          </View>
          <If when={unavailableEditTarget()}>
            <Text style={{ ...captionTextStyle, color: C.danger }}>
              {tr('Discovery plan changed')}
            </Text>
            {action('New discovery plan', () => void edit(true))}
          </If>
        </If>
        <If when={!editing() && detail()?.task.status === 'paused' && !detail()?.approved}>
          <Text style={{ ...captionTextStyle, color: C.muted }}>
            {tr(
              resolvedWorkerTools() === 'session'
                ? 'Discovery permission notice'
                : 'Discovery read-only notice',
            )}
          </Text>
        </If>
      </Scroll>
      <If when={Boolean(error() || watchError())}>
        <Text style={{ ...captionTextStyle, color: C.danger }}>
          {renderText(error() || watchError())}
        </Text>
      </If>
      <If when={editing() && platform.idiom !== 'terminal'}>
        <View style={{ height: 1, marginHorizontal: -24, backgroundColor: C.line }} />
      </If>
      <DialogFooter>
        <If when={editing() && !deleting()}>
          <Text
            style={{
              ...captionTextStyle,
              color: C.muted,
              flexGrow: 1,
              flexBasis: windowSize().width < 440 ? '100%' : 0,
            }}
          >
            {tr('Discovery model cost')}
          </Text>
        </If>
        <If when={deleting()}>
          <Text style={{ ...captionTextStyle, color: C.text }}>{tr('Delete discovery plan?')}</Text>
          <SettingsButton
            label={tr('Cancel')}
            disabled={busy()}
            onPress={() => deleting.set(false)}
          />
          <SettingsButton
            label={tr('Delete')}
            tone="danger"
            disabled={busy() || !!detail()?.pendingFire}
            onPress={() => void change('delete')}
          />
        </If>
        <If when={!deleting()}>
          <If when={!watching()}>{action('Refresh', () => void watch())}</If>
          <SettingsButton
            label={tr(editing() ? 'Cancel' : 'Close')}
            onPress={cancel}
            disabled={busy()}
          />
          <If when={editing()}>
            <SettingsButton
              label={tr(
                reapproving() && (editingPlan()?.approved || needsRenewedApproval(editingPlan()))
                  ? 'Approve and resume discovery'
                  : editingPlan() && !reapproving()
                    ? 'Approve and save discovery'
                    : 'Approve and enable discovery',
              )}
              tone="primary"
              onPress={() => void save()}
              disabled={
                busy() ||
                loading() ||
                !basis() ||
                !!intervalError() ||
                !toolPreview() ||
                (!!editingPlan() && !!detail()?.pendingFire) ||
                unavailableEditTarget()
              }
            />
          </If>
          <If when={!editing() && detail()?.task.status === 'paused'}>
            <SettingsButton
              label={tr(detail()!.approved ? 'Resume discovery' : 'Review discovery permissions')}
              tone="primary"
              onPress={() => (detail()!.approved ? void change('resume') : void edit(false, true))}
              disabled={busy() || !!detail()!.pendingFire}
            />
          </If>
          <If when={!editing() && detail()?.task.status === 'active'}>
            <SettingsButton
              label={tr('Run discovery now')}
              tone="primary"
              onPress={() => void change('trigger_now')}
              disabled={busy() || !!detail()!.pendingFire || !detail()!.approved}
            />
          </If>
        </If>
      </DialogFooter>
    </ModalDialog>
  );
}
