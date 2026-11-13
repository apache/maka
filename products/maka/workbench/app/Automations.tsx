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
import { cleanup, inputAction, Scroll, signal, Text, View } from 'nsh';
import type {
  AgentScheduleChange,
  AgentScheduleResult,
  AgentScheduledDetail,
  AgentScheduledEffect,
  AgentScheduledSummary,
  AgentSession,
  Schedule,
} from '../../../../packages/plugin-sdk/src/generated/runtime';
import { useHost } from './host';
import { DialogFooter, DialogHeader, ModalDialog } from './ModalDialog';
import { SettingsButton, SettingsSelect } from './SettingsPage';
import { SettingsField } from './SettingsField';
import { settingsValue } from './settingsOperations';
import { createText, errorMessage, message } from './text';
import { currentLocale, tr, type MessageKey } from './locale';
import { C, captionTextStyle, bodyTextStyle } from './ui';
import { LoadingIndicator } from './Loading';

const triggers = [
  ['once', 'Once at a specific time'],
  ['interval', 'Repeating interval'],
  ['daily', 'Daily at a local time'],
  ['weekly', 'Weekly at a local time'],
  ['monthly', 'Monthly at a local time'],
  ['cron', 'Cron schedule'],
  ['script', 'Script condition'],
] as const satisfies readonly (readonly [string, MessageKey])[];
const deliveries = [
  ['steering', 'Steer current turn'],
  ['followup', 'Wait for the next turn'],
  ['new', 'Start a new conversation'],
] as const satisfies readonly (readonly [string, MessageKey])[];

type Trigger = (typeof triggers)[number][0];
type Delivery = (typeof deliveries)[number][0];
type Editor = { detail: AgentScheduledDetail | null };

function localDateTime(ms: number) {
  const date = new Date(ms);
  return new Date(ms - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 19);
}
function dateCaption(at: number) {
  return new Date(at).toLocaleString(currentLocale(), {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

function AutomationEditor(props: {
  detail: AgentScheduledDetail | null;
  sessions(): readonly AgentSession[];
  target(): string | null;
  pending(): boolean;
  saveError(): string;
  browseMore?: () => void;
  save(change: AgentScheduleChange): Promise<boolean>;
  close(): void;
}) {
  const task = props.detail?.task;
  const schedule = task?.schedule;
  const effect = task?.effect;
  const trigger = signal<Trigger>(
    schedule?.kind === 'calendar' ? schedule.recurrence : (schedule?.kind ?? 'once'),
  );
  const delivery = signal<Delivery>(
    effect?.kind === 'agent_run' ? 'new' : (effect?.delivery ?? 'steering'),
  );
  const title = signal(task?.title ?? '');
  const text = signal(task?.intent.body ?? '');
  const selected = signal(effect?.target.sessionId ?? props.target());
  const timezone = signal(
    props.detail?.timezone ?? new Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC',
  );
  const start = signal(
    localDateTime(
      schedule?.kind === 'once'
        ? schedule.runAt
        : schedule?.kind === 'calendar'
          ? schedule.anchorAt
          : (schedule?.startAt ?? Date.now() + 3_600_000),
    ),
  );
  const seconds = signal(
    String(
      schedule?.kind === 'interval' || schedule?.kind === 'script'
        ? (schedule.everySeconds ?? 60)
        : 60,
    ),
  );
  const script = signal(schedule?.kind === 'script' ? schedule.source : '');
  const cron = signal(schedule?.kind === 'cron' ? schedule.expression : '');
  const error = createText();
  const choices = () =>
    props.sessions().filter((session) => !session.archived && session.backend?.kind === 'model');
  const target = () => choices().find((session) => session.id === selected());
  const submit = async () => {
    if (props.pending()) return;
    error.set('');
    const session = target();
    const backend = session?.backend;
    if (!session || backend?.kind !== 'model') {
      error.set(message('Choose a conversation with a model'));
      return;
    }
    const when = trigger();
    const everySeconds = Number(seconds().trim());
    const startAt = Date.parse(start().trim());
    let next: Schedule;
    switch (when) {
      case 'script':
      case 'interval':
        if (!Number.isInteger(everySeconds) || everySeconds <= 0 || everySeconds > 0xffffffff) {
          error.set(message('Enter a positive number of seconds'));
          return;
        }
        next =
          when === 'script'
            ? {
                kind: 'script',
                source: script(),
                everySeconds,
                startAt: schedule?.kind === 'script' ? schedule.startAt : Date.now(),
              }
            : {
                kind: 'interval',
                everySeconds,
                startAt: schedule?.kind === 'interval' ? schedule.startAt : Date.now(),
              };
        break;
      case 'once':
      case 'daily':
      case 'weekly':
      case 'monthly':
      case 'cron':
        if (!Number.isFinite(startAt)) {
          error.set(message('Enter a valid date and time'));
          return;
        }
        next =
          when === 'once'
            ? { kind: 'once', runAt: startAt }
            : when === 'cron'
              ? { kind: 'cron', expression: cron(), startAt }
              : { kind: 'calendar', recurrence: when, anchorAt: startAt };
        break;
    }
    const common = {
      target: {
        sessionId: session.id,
        workspace: session.workspace,
        permissions: session.permissions,
        boundaryRevision: session.boundaryRevision,
        binding: session.binding,
      },
      model: { connectionId: backend.connectionId, modelId: backend.modelId },
      thinkingLevel: backend.thinkingLevel,
    };
    const mode = delivery();
    const destination: AgentScheduledEffect =
      mode === 'new'
        ? { kind: 'agent_run', ...common }
        : { kind: 'session', delivery: mode, ...common };
    const input = {
      timezone: timezone().trim(),
      misfire: props.detail?.misfire ?? 'skip',
      task: {
        title: title(),
        intentBody: text(),
        effect: destination,
        schedule: next,
        maxFires: task?.maxFires,
        expiresAt: task?.expiresAt,
      },
    } as const;
    await props.save(
      props.detail
        ? { kind: 'update', taskId: props.detail.task.id, revision: props.detail.revision, input }
        : { kind: 'create', input },
    );
  };
  const time = () => ['once', 'daily', 'weekly', 'monthly', 'cron'].includes(trigger());
  const recurring = () => ['daily', 'weekly', 'monthly', 'cron'].includes(trigger());
  return (
    <>
      <DialogHeader title={tr(props.detail ? 'Edit automation' : 'New automation')} />
      <Scroll
        style={{ flex: 1, minHeight: 0 }}
        contentStyle={{ gap: 14, paddingRight: 6, paddingBottom: 8 }}
      >
        <SettingsField label={tr('Automation name')} value={title()} change={title.set} autoFocus />
        <SettingsField
          label={tr('Automation message')}
          value={text()}
          change={text.set}
          multiline
        />
        <SettingsSelect
          label={tr('Target conversation')}
          value={selected()}
          choices={choices().map((row) => ({ value: row.id, title: row.title }))}
          change={selected.set}
          placeholder={tr('Choose a conversation with a model')}
        />
        <If when={props.browseMore}>
          <SettingsButton
            label={tr('Load more conversations')}
            tone="quiet"
            onPress={() => props.browseMore?.()}
          />
        </If>
        <SettingsSelect
          label={tr('Automation delivery')}
          value={delivery()}
          choices={deliveries.map(([value, key]) => ({ value, title: tr(key) }))}
          change={(value) => delivery.set(value as Delivery)}
        />
        <SettingsSelect
          label={tr('Trigger type')}
          value={trigger()}
          choices={triggers.map(([value, key]) => ({ value, title: tr(key) }))}
          change={(value) => trigger.set(value as Trigger)}
        />
        <If when={time()}>
          <SettingsField
            label={tr('Automation local time')}
            value={start()}
            change={start.set}
            placeholder="2026-11-13T09:00"
          />
        </If>
        <If when={recurring()}>
          <SettingsField
            label={tr('Automation time zone')}
            value={timezone()}
            change={timezone.set}
          />
        </If>
        <If when={trigger() === 'cron'}>
          <SettingsField
            label={tr('Cron expression')}
            value={cron()}
            change={cron.set}
            placeholder="0 9 * * 1-5"
          />
        </If>
        <If when={trigger() === 'interval' || trigger() === 'script'}>
          <SettingsField
            label={tr(
              trigger() === 'script' ? 'Check interval in seconds' : 'Repeat interval in seconds',
            )}
            value={seconds()}
            change={seconds.set}
          />
        </If>
        <If when={trigger() === 'script'}>
          <SettingsField
            label={tr('Script condition')}
            value={script()}
            change={script.set}
            multiline
            hint={tr('Script check guidance')}
            placeholder="return (await tools.Read({ path: 'status.txt' })).content.trim() === 'ready';"
          />
        </If>
      </Scroll>
      <If when={error() || props.saveError()}>
        <Text style={{ ...captionTextStyle, color: C.danger, userSelect: 'text' }}>
          {error() || props.saveError()}
        </Text>
      </If>
      <DialogFooter>
        <SettingsButton label={tr('Cancel')} onPress={props.close} disabled={props.pending()} />
        <SettingsButton
          label={tr('Save')}
          onPress={() => void submit()}
          tone="primary"
          disabled={
            props.pending() ||
            !title().trim() ||
            !text().trim() ||
            (trigger() === 'script' && !script().trim())
          }
        />
      </DialogFooter>
    </>
  );
}

export function Automations(props: {
  selected(): string | null;
  openConversation(id: string): void;
  close(): void;
}) {
  const host = useHost();
  const tasks = signal<AgentScheduledSummary[]>([]);
  const sessions = signal<AgentSession[]>([]);
  const nextSession = signal<{ cursor: string; revision: string } | null>(null);
  const next = signal<string | null>(null);
  const revision = signal(0);
  const loading = signal(true);
  const pending = signal(false);
  const editor = signal<Editor | null>(null);
  const deleting = signal<AgentScheduledSummary | null>(null);
  const error = createText();
  let alive = true;
  let sessionLoading = false;
  let subscription: { close(): Promise<void> } | null = null;
  cleanup(() => {
    alive = false;
    void subscription?.close();
  });

  const loadSessions = async (after: { cursor: string; revision: string } | null) => {
    if (sessionLoading) return;
    sessionLoading = true;
    try {
      const result = await host.query('agent', 'list', {
        filter: 'all',
        position: after ? { kind: 'after', ...after } : { kind: 'start' },
      });
      if (!alive) return;
      sessions.set([
        ...new Map([...sessions(), ...result.sessions].map((row) => [row.id, row])).values(),
      ]);
      nextSession.set(result.after ? { cursor: result.after, revision: result.revision } : null);
    } catch (reason) {
      if (alive) error.set(errorMessage(reason));
    } finally {
      sessionLoading = false;
    }
  };
  const read = { kind: 'list' } as const;
  void (async () => {
    try {
      const opened = await host.subscribe('agent', 'watchSchedules', read);
      if (!alive) {
        await opened.close();
        return;
      }
      subscription = opened;
      for (;;) {
        const page = await opened.next();
        if (!alive || page === null) break;
        if (page.kind !== 'page') continue;
        tasks.set(page.tasks);
        revision.set(page.revision);
        next.set(page.nextCursor ?? null);
        loading.set(false);
      }
    } catch (reason) {
      if (alive)
        error.set(
          message('Could not load automations: {reason}', { reason: errorMessage(reason) }),
        );
    } finally {
      if (alive) loading.set(false);
    }
  })();
  const loadMore = async (cursor: string) => {
    try {
      const expected = revision();
      const page = await host.query('agent', 'schedules', {
        ...read,
        cursor,
        expectedRevision: expected,
      });
      if (alive && revision() === expected && page.kind === 'page') {
        tasks.set([...new Map([...tasks(), ...page.tasks].map((row) => [row.id, row])).values()]);
        next.set(page.nextCursor ?? null);
      }
    } catch (reason) {
      if (alive)
        error.set(
          message('Could not load automations: {reason}', { reason: errorMessage(reason) }),
        );
    }
  };
  const edit = async (id?: string) => {
    if (pending()) return;
    error.set('');
    pending.set(true);
    try {
      let detail: AgentScheduledDetail | null = null;
      if (id) {
        const result = await host.query('agent', 'schedules', { kind: 'get', taskId: id });
        if (result.kind !== 'task' || !result.detail) {
          error.set(message('Automation changed. Reopen it to edit the latest version.'));
          return;
        }
        detail = result.detail;
      }
      const target = detail?.task.effect.target.sessionId ?? props.selected();
      if (target && !sessions().some((row) => row.id === target)) {
        const result = await host.query('agent', 'observe', { sessionId: target });
        if (alive && result.session) sessions.set([result.session, ...sessions()]);
      }
      if (alive) {
        editor.set({ detail });
        if (!sessions().length || nextSession() === null) void loadSessions(null);
      }
    } catch (reason) {
      if (alive)
        error.set(
          message('Could not load automations: {reason}', { reason: errorMessage(reason) }),
        );
    } finally {
      if (alive) pending.set(false);
    }
  };
  const save = async (change: AgentScheduleChange) => {
    if (pending()) return false;
    pending.set(true);
    error.set('');
    try {
      const result = settingsValue(
        (await host.control('schedule', change)).reply,
      ) as AgentScheduleResult;
      if (!alive) return false;
      if (result.kind === 'conflict') {
        error.set(message('Automation changed. Reopen it to edit the latest version.'));
        return false;
      }
      if (result.kind === 'rejected') {
        error.set(message('Could not save the automation: {reason}', { reason: result.reason }));
        return false;
      }
      editor.set(null);
      deleting.set(null);
      return true;
    } catch (reason) {
      if (alive)
        error.set(
          message('Could not save the automation: {reason}', { reason: errorMessage(reason) }),
        );
      return false;
    } finally {
      if (alive) pending.set(false);
    }
  };
  const closeEditor = () => {
    if (!pending()) {
      editor.set(null);
      error.set('');
    }
  };
  const close = () => {
    if (pending()) return;
    if (deleting()) deleting.set(null);
    else if (editor()) closeEditor();
    else props.close();
  };
  const feedback = () => (
    <If when={error()}>
      <Text style={{ ...captionTextStyle, color: C.danger }}>{error()}</Text>
    </If>
  );
  return (
    <ModalDialog size="editor" height={560} onCancel={close}>
      <If
        when={editor()}
        else={
          <>
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 8,
              }}
            >
              <DialogHeader title={tr('Automations')} />
              <SettingsButton
                label={tr('New automation')}
                icon="plus"
                tone="primary"
                disabled={pending()}
                onPress={() => void edit()}
              />
            </View>
            <Scroll style={{ flex: 1, minHeight: 0 }} contentStyle={{ gap: 8, paddingRight: 4 }}>
              <If when={loading()}>
                <LoadingIndicator label={tr('Loading…')} color={C.muted} />
              </If>
              <If when={!loading() && !tasks().length && !error()}>
                <Text style={{ ...bodyTextStyle, color: C.muted, paddingVertical: 20 }}>
                  {tr('No automations yet')}
                </Text>
              </If>
              <Each of={tasks()} key={(task) => task.id}>
                {(task) => {
                  const editable = () => task().status === 'active' || task().status === 'paused';
                  return (
                    <View
                      style={{
                        padding: 10,
                        borderRadius: 8,
                        backgroundColor: C.background,
                        gap: 6,
                      }}
                    >
                      <Text style={{ ...bodyTextStyle, color: C.text }}>{task().title}</Text>
                      <Text style={{ ...captionTextStyle, color: C.muted }}>
                        {tr(
                          task().status === 'paused'
                            ? 'Schedule paused'
                            : task().status === 'expired'
                              ? 'Schedule expired'
                              : task().status === 'completed'
                                ? 'Completed'
                                : 'Schedule active',
                        )}
                        {task().pendingFire
                          ? ` · ${tr('Automation is delivering a message')}`
                          : task().status === 'active' && task().nextFireAt != null
                            ? ` · ${tr(task().script ? 'Automation next check: {time}' : 'Automation next run: {time}', { time: dateCaption(task().nextFireAt!) })}`
                            : ''}
                      </Text>
                      <If when={task().lastError}>
                        <Text style={{ ...captionTextStyle, color: C.danger, userSelect: 'text' }}>
                          {task().lastError}
                        </Text>
                      </If>
                      <View
                        style={{
                          flexDirection: 'row',
                          flexWrap: 'wrap',
                          alignItems: 'center',
                          gap: 4,
                        }}
                      >
                        <SettingsButton
                          label={tr('Open automation conversation')}
                          tone="quiet"
                          onPress={inputAction(props.openConversation, task().sessionId)}
                        />
                        <If when={editable()}>
                          <SettingsButton
                            label={tr('Edit automation')}
                            icon="edit"
                            tone="quiet"
                            iconOnly
                            disabled={pending() || !!task().pendingFire}
                            onPress={() => void edit(task().id)}
                          />
                          <SettingsButton
                            label={tr(
                              task().status === 'paused' ? 'Resume automation' : 'Pause automation',
                            )}
                            tone="quiet"
                            disabled={pending()}
                            onPress={() =>
                              void save({
                                kind: task().status === 'paused' ? 'resume' : 'pause',
                                taskId: task().id,
                                revision: task().revision,
                              })
                            }
                          />
                        </If>
                        <SettingsButton
                          label={tr('Delete')}
                          icon="trash"
                          tone="danger"
                          iconOnly
                          disabled={pending() || !!task().pendingFire}
                          onPress={inputAction(deleting.set, task())}
                        />
                      </View>
                    </View>
                  );
                }}
              </Each>
              <If when={next()}>
                <SettingsButton
                  label={tr('Load more')}
                  tone="quiet"
                  onPress={() => void loadMore(next()!)}
                />
              </If>
            </Scroll>
            {feedback()}
            <DialogFooter>
              <If
                when={deleting()}
                else={<SettingsButton label={tr('Close')} onPress={close} disabled={pending()} />}
              >
                <Text style={{ ...captionTextStyle, color: C.text }}>
                  {tr('Delete automation?')}
                </Text>
                <SettingsButton
                  label={tr('Cancel')}
                  onPress={() => deleting.set(null)}
                  disabled={pending()}
                />
                <SettingsButton
                  label={tr('Delete')}
                  tone="danger"
                  disabled={pending()}
                  onPress={() => {
                    const task = deleting();
                    if (task)
                      void save({ kind: 'delete', taskId: task.id, revision: task.revision });
                  }}
                />
              </If>
            </DialogFooter>
          </>
        }
      >
        {(current) => (
          <AutomationEditor
            detail={current().detail}
            sessions={sessions}
            target={props.selected}
            browseMore={nextSession() ? () => void loadSessions(nextSession()) : undefined}
            pending={pending}
            saveError={error}
            save={save}
            close={closeEditor}
          />
        )}
      </If>
    </ModalDialog>
  );
}
