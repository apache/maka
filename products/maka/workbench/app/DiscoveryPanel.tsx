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
import { Button, Dialog } from 'nsh/base';
import type {
  AgentScheduledDetail,
  AgentScheduledSummary,
  ModelSelection,
  ThinkingLevel,
} from '../../../../packages/plugin-sdk/src/index.js';
import type { Host } from './host';
import { tr, type MessageKey } from './locale';
import { createText, errorText, UiError, renderText, message } from './text';
import { discoveryInput, discoveryTasks, type DiscoveryApproval } from './discoveryCore';
import { Icon } from './Icon';
import { SettingsField } from './SettingsField';
import { accessLabel } from './SessionPermissionsSelect';
import {
  C,
  bodyTextStyle,
  captionTextStyle,
  controlStyle,
  controlHoverStyle,
  controlFocusStyle,
  controlDisabledStyle,
  toolbarControlStyle,
  textTooltip,
} from './ui';
import { sameValue } from '../../../../plugins/shared/value';
import { dialogTop } from './chrome';

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
  const tasks = signal<AgentScheduledSummary[]>([]),
    selected = signal<string | null>(null);
  const showFollowups = signal(false);
  const visibleTasks = () =>
    showFollowups() ? tasks() : tasks().filter((task) => !task.backgroundFollowup);
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
  const error = createText();
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
    formGeneration = 0,
    initial = true;
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
  const readDetail = async (id: string, fill = false) => {
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
    if (!alive || selected() !== id || ticket !== generation) return;
    if (fill) {
      intent.set(value.detail.task.intent.body);
      if (value.detail.task.schedule.kind === 'interval')
        minutes.set(String(value.detail.task.schedule.everySeconds / 60));
    }
  };
  const select = async (id: string) => {
    if (busy()) return;
    formGeneration++;
    selected.set(id);
    editing.set(false);
    detail.set(null);
    error.set('');
    try {
      await readDetail(id, true);
    } catch (reason) {
      if (alive) error.set(errorText(reason));
    }
  };
  const edit = async (fresh: boolean) => {
    if (busy()) return;
    const ticket = ++formGeneration;
    editingPlan.set(fresh ? null : detail());
    if (fresh) {
      selected.set(null);
      detail.set(null);
      intent.set('');
      minutes.set('30');
    }
    editing.set(true);
    basis.set(null);
    error.set('');
    try {
      const captured = await capture();
      if (alive && ticket === formGeneration) basis.set(captured);
    } catch (reason) {
      if (alive) error.set(errorText(reason));
    }
  };
  const watch = async () => {
    if (watching()) return;
    watching.set(true);
    error.set('');
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
        {
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
          if (initial) {
            initial = false;
            const plans = visibleTasks();
            const first =
              plans.find((task) => !task.approved && task.status === 'paused') ?? plans[0];
            if (first) await select(first.id);
            else await edit(true);
          } else if (selected()) await readDetail(selected()!);
        }
      }
      if (alive) error.set(message('Discovery updates disconnected'));
    } catch (reason) {
      if (alive) error.set(errorText(reason));
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
      if (alive) error.set(errorText(reason));
    } finally {
      if (alive) busy.set(false);
    }
  };
  const save = async () => {
    const captured = basis();
    if (!captured || busy()) return;
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
        'UTC',
        current,
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
        selected.set(result.taskId);
        editing.set(false);
        await readDetail(result.taskId, true);
      }
    } catch (reason) {
      if (alive) error.set(errorText(reason));
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
    if (!current.approved) return 'Discovery needs approval';
    return current.task.status === 'active' ? 'Discovery active' : 'Discovery paused';
  };
  const snapshot = () => {
    if (editing()) return basis();
    const effect = detail()?.task.effect;
    return effect?.kind === 'discovery' ? effect : null;
  };
  const last = () => detail()?.task.runs[0];
  const time = (at: number | null | undefined) =>
    at == null ? '—' : `${new Date(at).toISOString().slice(0, 19).replace('T', ' ')} UTC`;
  const outcome = (): MessageKey =>
    last()?.outcome === 'failed'
      ? 'Discovery failed'
      : last()?.outcome === 'blocked'
        ? 'Discovery blocked'
        : last()?.message === 'No report'
          ? 'Discovery no report'
          : 'Discovery reported';
  const toggleFollowups = async () => {
    showFollowups.set(!showFollowups());
    if (
      !showFollowups() &&
      tasks().some((task) => task.id === selected() && task.backgroundFollowup)
    ) {
      const first = visibleTasks()[0];
      if (first) await select(first.id);
      else await edit(true);
    }
  };
  const action = (label: MessageKey, run: () => void, disabled = false) => (
    <Button
      accessibilityLabel={tr(label)}
      onPress={inputAction(run, null)}
      disabled={busy() || disabled}
      style={controlStyle}
      hoverStyle={controlHoverStyle()}
      focusStyle={controlFocusStyle()}
      disabledStyle={controlDisabledStyle}
    >
      <Text style={{ ...captionTextStyle, color: C.text }}>{tr(label)}</Text>
    </Button>
  );
  return (
    <Dialog
      animation="none"
      closeOnBackdropPress={!busy()}
      closeOnEscape={!busy()}
      onCancel={() => {
        if (!busy()) props.close();
      }}
      style={{
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        padding: 20,
        paddingTop: dialogTop(20),
        backgroundColor: C.scrim,
      }}
    >
      <View
        style={{
          width: '100%',
          maxWidth: 620,
          maxHeight: '90%',
          minHeight: 0,
          padding: 24,
          gap: 16,
          borderRadius: 16,
          backgroundColor: C.surface,
          borderWidth: 1,
          borderColor: C.line,
        }}
      >
        <View
          style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}
        >
          <Text style={{ color: C.text, fontSize: 18, fontWeight: '600' }}>
            {tr('Proactive discovery')}
          </Text>
          {action('Close', props.close)}
        </View>
        <Scroll style={{ minHeight: 0, flexShrink: 1 }}>
          <View style={{ gap: 16 }}>
            <If when={loading()}>
              <Text style={{ color: C.secondary }}>{tr('Loading…')}</Text>
            </If>
            <If
              when={
                visibleTasks().length > 1 || visibleTasks().some((task) => task.id !== selected())
              }
            >
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                <Each of={visibleTasks()} key={(task) => task.id}>
                  {(task) => (
                    <Button
                      onPress={() => void select(task().id)}
                      disabled={busy()}
                      style={{
                        ...controlStyle,
                        backgroundColor: selected() === task().id ? C.raised : C.background,
                      }}
                    >
                      <Text style={{ color: C.text }}>{task().title}</Text>
                    </Button>
                  )}
                </Each>
              </View>
            </If>
            <If when={tasks().some((task) => task.backgroundFollowup)}>
              {action(
                showFollowups() ? 'Hide background follow-ups' : 'View background follow-ups',
                () => void toggleFollowups(),
              )}
            </If>
            <Text accessibilityLabel={tr(state())} style={{ ...bodyTextStyle, color: C.text }}>
              {tr(state())}
            </Text>
            <If when={snapshot() !== null}>
              <View style={{ gap: 6 }}>
                <Text style={{ ...captionTextStyle, color: C.secondary }}>
                  {tr('Discovery workspace')}: {snapshot()!.target.workspace.path}
                </Text>
                <Text style={{ ...captionTextStyle, color: C.secondary }}>
                  {tr('Discovery permissions')}:{' '}
                  {accessLabel(snapshot()!.target.permissions.access)}
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
              <Text style={{ ...captionTextStyle, color: C.muted }}>
                {tr('Discovery permission notice')}
              </Text>
              <View style={{ flexDirection: 'row', gap: 8 }}>
                {action(
                  selected() ? 'Approve and save discovery' : 'Approve and enable discovery',
                  () => void save(),
                  !basis() || loading() || !!detail()?.pendingFire,
                )}
              </View>
            </If>
            <If when={!editing() && detail() !== null}>
              <Text style={{ ...captionTextStyle, color: C.secondary }}>
                {tr('Discovery next check')}:{' '}
                {detail()!.task.status === 'active' ? time(detail()!.task.nextFireAt) : '—'}
              </Text>
              <Text style={{ ...captionTextStyle, color: C.secondary }}>
                {tr('Discovery last check')}: {time(last()?.at)}
              </Text>
              <Text style={{ ...captionTextStyle, color: C.secondary }}>
                {last() ? tr(outcome()) : tr('Discovery no history')}
              </Text>
              <If when={detail()!.task.lastError}>
                <Text style={{ ...captionTextStyle, color: C.danger }}>
                  {detail()!.task.lastError}
                </Text>
              </If>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                {detail()!.task.status === 'active'
                  ? action('Pause discovery', () => void change('pause'))
                  : action(
                      detail()!.approved ? 'Resume discovery' : 'Approve and enable discovery',
                      () => void change(detail()!.approved ? 'resume' : 'approve'),
                      !!detail()!.pendingFire,
                    )}
                {action(
                  'Run discovery now',
                  () => void change('trigger_now'),
                  detail()!.task.status !== 'active' ||
                    !!detail()!.pendingFire ||
                    !detail()!.approved,
                )}
                {action('Edit discovery plan', () => void edit(false), !!detail()!.pendingFire)}
              </View>
              <If when={!!(detail()?.investigation?.sessionId || last()?.sessionId)}>
                {action('Open investigation', () =>
                  props.openWorker(detail()!.investigation?.sessionId ?? last()!.sessionId!),
                )}
              </If>
              {action('New discovery plan', () => void edit(true))}
            </If>
            <If when={error()}>
              <Text style={{ ...captionTextStyle, color: C.danger }}>{renderText(error())}</Text>
            </If>
            <If when={!watching()}>{action('Refresh', () => void watch())}</If>
          </View>
        </Scroll>
      </View>
    </Dialog>
  );
}
