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
import { cleanup, signal, Text, View, Scroll, inputAction } from 'nsh';
import { Button } from 'nsh/base';
import type {
  AgentScheduledDetail,
  AgentScheduledSummary,
  IntervalCadence,
  ModelSelection,
  ThinkingLevel,
} from '../../../../packages/plugin-sdk/src/index.js';
import type { Host } from './host';
import { currentLocale, tr, type MessageKey } from './locale';
import { createText, errorText, UiError, renderText, message } from './text';
import {
  discoveryCadence,
  discoveryInput,
  discoveryTasks,
  discoveryWorkerTools,
  type DiscoveryApproval,
  type DiscoveryWorkerTools,
} from './discoveryCore';
import { Icon } from './Icon';
import { SettingsField } from './SettingsField';
import { SettingsButton, SettingsSegmented, SettingsSelect } from './SettingsPage';
import { DialogFooter, DialogHeader, ModalDialog } from './ModalDialog';
import { LoadingIndicator } from './Loading';
import { accessLabel } from './SessionPermissionsSelect';
import { C, bodyTextStyle, captionTextStyle, toolbarControlStyle, textTooltip } from './ui';
import { sameValue } from '../../../../plugins/shared/value';

type Props = {
  host: Host;
  sessionId: string;
  control(method: string, input: unknown): Promise<any>;
  selection(): Promise<{ model: ModelSelection; thinkingLevel: ThinkingLevel | null } | null>;
  openWorker(id: string): void;
  chooseModel(): void;
};

export function DiscoveryPanel(props: Props) {
  const open = signal(false);
  return (
    <>
      <Button
        accessibilityLabel={tr('Proactive discovery')}
        tooltip={textTooltip(() => tr('Proactive discovery'))}
        style={{ ...toolbarControlStyle, flexDirection: 'row', gap: 6, alignItems: 'center' }}
        onPress={inputAction(() => open.set(true), null)}
        hoverStyle={{ backgroundColor: C.card }}
      >
        <Icon name="activity" color={C.secondary} />
        <Text style={{ ...captionTextStyle, color: C.secondary }}>{tr('Proactive discovery')}</Text>
      </Button>
      <If when={open()}>
        <DiscoveryDialog {...props} close={() => open.set(false)} />
      </If>
    </>
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
  const workerTools = signal<DiscoveryWorkerTools>('session');
  const resolvedWorkerTools = () =>
    editing() ? workerTools() : discoveryWorkerTools(detail()?.task.effect);
  const error = createText();
  const watchError = createText();
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
  const capture = async (): Promise<DiscoveryApproval> => {
    const chosen = await props.selection();
    if (!chosen) throw new UiError('Choose a model before sending.');
    const { session } = await props.host.query('agent', 'observe', { sessionId: props.sessionId });
    await describeModel(chosen.model);
    return {
      target: {
        sessionId: session.id,
        workspace: session.workspace,
        permissions: session.permissions,
        boundaryRevision: session.boundaryRevision,
        binding: session.binding,
      },
      ...chosen,
    };
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
    detail.set(null);
    error.set('');
    try {
      await readDetail(id);
    } catch (reason) {
      if (alive) error.set(errorText(reason, 'Could not load the discovery plan.'));
    }
  };
  const edit = async (fresh: boolean) => {
    const plan = fresh ? null : detail();
    if (busy() || (!fresh && !plan)) return;
    const ticket = ++formGeneration;
    editingPlan.set(plan);
    workerTools.set(fresh ? 'session' : discoveryWorkerTools(plan?.task.effect));
    intent.set(plan?.task.intent.body ?? '');
    const schedule = plan?.task.schedule;
    minutes.set(schedule?.kind === 'interval' ? String(schedule.everySeconds / 60) : '30');
    cadence.set(discoveryCadence(schedule));
    editing.set(true);
    basis.set(null);
    error.set('');
    try {
      const captured = await capture();
      if (alive && ticket === formGeneration) basis.set(captured);
    } catch (reason) {
      if (alive) error.set(errorText(reason, 'Could not load the discovery plan.'));
    }
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
            const plans = visibleTasks();
            const first =
              plans.find((plan) => !plan.approved && plan.status === 'paused') ?? plans[0];
            if (first) await select(first.id);
            else await edit(true);
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
  const change = async (action: 'pause' | 'resume' | 'approve' | 'trigger_now') => {
    const current = detail();
    if (!current || busy()) return;
    busy.set(true);
    error.set('');
    try {
      const result = await props.control('schedule', {
        kind: action,
        taskId: current.task.id,
        revision: current.revision,
      });
      if (result.kind === 'conflict') throw new UiError('Discovery plan changed');
      if (result.kind === 'rejected') throw new Error(result.reason);
      if (alive) await readDetail(current.task.id);
    } catch (reason) {
      if (alive) error.set(errorText(reason, 'Could not update the discovery plan.'));
    } finally {
      if (alive) busy.set(false);
    }
  };
  const save = async () => {
    const captured = basis();
    if (!captured || busy() || unavailableEditTarget()) return;
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
        throw new UiError('Discovery settings changed');
      }
      const result = await props.control(
        'schedule',
        id && current
          ? { kind: 'update', taskId: id, revision: current.revision, input }
          : { kind: 'create', input },
      );
      if (result.kind === 'conflict') throw new UiError('Discovery plan changed');
      if (result.kind === 'rejected') throw new Error(result.reason);
      if (alive) {
        if (selected() !== result.taskId) detail.set(null);
        selected.set(result.taskId);
        editing.set(false);
        await readDetail(result.taskId);
      }
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
    if (!current.approved) return 'Discovery needs approval';
    return current.task.status === 'active' ? 'Discovery active' : 'Discovery paused';
  };
  const snapshot = () => {
    if (editing()) return basis();
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
    const plans = visibleTasks();
    const plan = plans.find((task) => task.id === selected()) ?? plans[0];
    if (editing() && plan) void select(plan.id);
    else props.close();
  };
  const toggleFollowups = async () => {
    showFollowups.set(!showFollowups());
    if (
      !showFollowups() &&
      tasks().some((task) => task.id === selected() && task.backgroundFollowup)
    ) {
      const first = tasks().find((task) => !task.backgroundFollowup);
      if (first) await select(first.id);
      else {
        selected.set(null);
        detail.set(null);
        await edit(true);
      }
    }
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
    <ModalDialog size="form" onCancel={cancel}>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
        }}
      >
        <DialogHeader
          title={tr(
            editing()
              ? editingPlan()
                ? 'Edit discovery plan'
                : 'New discovery plan'
              : 'Proactive discovery',
          )}
        />
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
            <If when={detail()!.task.lastError}>
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
                {action('Edit discovery plan', () => void edit(false), !!detail()!.pendingFire)}
              </If>
              <If when={detail()!.task.status === 'active'}>
                {action('Pause discovery', () => void change('pause'))}
              </If>
            </View>
          </View>
        </If>
        <If when={snapshot() !== null}>
          <View style={{ gap: 4 }}>
            <Text style={{ ...captionTextStyle, color: C.secondary, userSelect: 'text' }}>
              {tr('Discovery workspace')}: {snapshot()!.target.workspace.path}
            </Text>
            <Text style={{ ...captionTextStyle, color: C.secondary }}>
              {tr('Discovery permissions')}:{' '}
              {resolvedWorkerTools() === 'session'
                ? tr('Use standard Session tools') +
                  ' · ' +
                  accessLabel(snapshot()!.target.permissions.access)
                : tr('Use read-only investigation tools')}
            </Text>
            <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
              <Text style={{ ...captionTextStyle, color: C.secondary, flexShrink: 1 }}>
                {tr('Discovery model')}: {modelLabel()}
              </Text>
              <If when={editing()}>
                {action('Change discovery model', () => {
                  props.close();
                  props.chooseModel();
                })}
              </If>
            </View>
          </View>
        </If>
        <If when={editing()}>
          <If
            when={!editingPlan() || editingPlan()!.task.schedule.kind === 'interval'}
            else={
              <Text style={{ ...captionTextStyle, color: C.secondary }}>
                {tr('Discovery existing schedule')}
              </Text>
            }
          >
            <SettingsSegmented
              label={tr('Discovery cadence')}
              value={cadence()}
              choices={[
                { value: 'after_completion', title: tr('Discovery after completion') },
                { value: 'fixed', title: tr('Discovery fixed interval') },
              ]}
              change={(value) => cadence.set(value === 'fixed' ? 'fixed' : 'after_completion')}
              disabled={busy()}
            />
            <SettingsField
              label={tr('Discovery interval (minutes)')}
              value={minutes()}
              change={minutes.set}
              disabled={busy()}
            />
          </If>
          <SettingsField
            label={tr('Discovery instructions')}
            placeholder={tr('Discovery broad placeholder')}
            value={intent()}
            change={intent.set}
            multiline
            disabled={busy()}
          />
          <SettingsSegmented
            label={tr('Discovery tools')}
            value={workerTools()}
            choices={[
              { value: 'session', title: tr('Use standard Session tools') },
              { value: 'read_only', title: tr('Use read-only investigation tools') },
            ]}
            change={(value) => workerTools.set(value === 'session' ? 'session' : 'read_only')}
            disabled={busy()}
          />
          <If when={unavailableEditTarget()}>
            <Text style={{ ...captionTextStyle, color: C.danger }}>
              {tr('Discovery plan changed')}
            </Text>
            {action('New discovery plan', () => void edit(true))}
          </If>
        </If>
        <If when={editing() || (detail()?.task.status === 'paused' && !detail()?.approved)}>
          <Text style={{ ...captionTextStyle, color: C.muted }}>
            {tr(
              resolvedWorkerTools() === 'session'
                ? 'Discovery permission notice'
                : 'Discovery read-only notice',
            )}
          </Text>
        </If>
      </Scroll>
      <If when={error()}>
        <Text style={{ ...captionTextStyle, color: C.danger }}>{renderText(error())}</Text>
      </If>
      <If when={watchError()}>
        <Text style={{ ...captionTextStyle, color: C.danger }}>{renderText(watchError())}</Text>
      </If>
      <DialogFooter>
        <If when={!watching()}>{action('Refresh', () => void watch())}</If>
        <SettingsButton
          label={tr(editing() ? 'Cancel' : 'Close')}
          onPress={cancel}
          disabled={busy()}
        />
        <If when={editing()}>
          <SettingsButton
            label={tr(
              editingPlan() ? 'Approve and save discovery' : 'Approve and enable discovery',
            )}
            tone="primary"
            onPress={() => void save()}
            disabled={
              busy() ||
              loading() ||
              !basis() ||
              (!!editingPlan() && !!detail()?.pendingFire) ||
              unavailableEditTarget()
            }
          />
        </If>
        <If when={!editing() && detail()?.task.status === 'paused'}>
          <SettingsButton
            label={tr(detail()!.approved ? 'Resume discovery' : 'Approve and enable discovery')}
            tone="primary"
            onPress={() => void change(detail()!.approved ? 'resume' : 'approve')}
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
      </DialogFooter>
    </ModalDialog>
  );
}
