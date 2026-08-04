import {
  botDisplayLabel,
  formatPlanReminderDeliveryMessage,
  isBotDeliveryProvider,
} from '@maka/core';
import type {
  BotProvider,
  PlanReminder,
  WorkspacePrivacyContext,
} from '@maka/core';
import type { PlanReminderStore } from '@maka/storage';

const PLAN_REMINDER_DEFAULT_SNOOZE_MS = 10 * 60 * 1000;

export type PlanReminderChangedReason = 'created' | 'updated' | 'deleted' | 'triggered' | 'blocked';

export interface PlanReminderMainService {
  list(): Promise<PlanReminder[]>;
  create(input: unknown): Promise<PlanReminder>;
  update(id: string, patch: unknown): Promise<PlanReminder>;
  setEnabled(id: string, enabled: boolean): Promise<PlanReminder>;
  triggerNow(id: string): Promise<PlanReminder>;
  snooze(id: string): Promise<PlanReminder>;
  clearRunHistory(id: string): Promise<PlanReminder>;
  delete(id: string): Promise<void>;
  refreshTimers(): Promise<void>;
  stopTimers(): void;
}

interface PlanReminderMainServiceDeps {
  store: PlanReminderStore;
  getPrivacyContext(): Promise<WorkspacePrivacyContext>;
  sendBotMessage(platform: BotProvider, chatId: string, text: string): Promise<unknown | null>;
  emitChanged(reason: PlanReminderChangedReason, reminder: Pick<PlanReminder, 'id'>): void;
  emitDue(reminder: PlanReminder): void;
}

export function createPlanReminderMainService(deps: PlanReminderMainServiceDeps): PlanReminderMainService {
  const timers = new Map<string, NodeJS.Timeout>();

  function clearTimer(id: string): void {
    const timer = timers.get(id);
    if (timer) clearTimeout(timer);
    timers.delete(id);
  }

  function schedule(reminder: PlanReminder): void {
    clearTimer(reminder.id);
    if (!reminder.enabled || reminder.status !== 'scheduled' || typeof reminder.nextRunAt !== 'number') return;
    const delay = Math.max(0, reminder.nextRunAt - Date.now());
    const timer = setTimeout(() => {
      timers.delete(reminder.id);
      void refreshTimers();
    }, Math.min(delay, 2_147_483_647));
    timers.set(reminder.id, timer);
  }

  async function refreshTimers(): Promise<void> {
    stopTimers();
    await triggerDue();
    const reminders = await deps.store.list();
    for (const reminder of reminders) schedule(reminder);
  }

  function stopTimers(): void {
    for (const id of Array.from(timers.keys())) clearTimer(id);
  }

  async function triggerDue(): Promise<void> {
    const due = await deps.store.listDue(Date.now());
    for (const reminder of due) {
      const now = Date.now();
      const privacy = await deps.getPrivacyContext();
      if (privacy.incognitoActive) {
        const blocked = await deps.store.markBlocked(reminder.id, {
          at: now,
          message: '隐私模式已开启，计划提醒没有触发。',
          blockReason: 'incognito_active',
        });
        deps.emitChanged('blocked', blocked);
        continue;
      }
      await deliver(reminder, now);
    }
  }

  async function deliver(reminder: PlanReminder, now: number): Promise<void> {
    if (reminder.delivery.channel === 'bot') {
      if (!isBotDeliveryProvider(reminder.delivery.platform)) {
        const blocked = await deps.store.markBlocked(reminder.id, {
          at: now,
          message: `${botDisplayLabel(reminder.delivery.platform)} 当前不是可投递目标，计划提醒没有投递。`,
          blockReason: 'bot_delivery_unavailable',
        });
        deps.emitChanged('blocked', blocked);
        return;
      }
      const sent = await deps
        .sendBotMessage(
          reminder.delivery.platform,
          reminder.delivery.chatId,
          formatPlanReminderDeliveryMessage(reminder),
        )
        .catch(() => null);
      if (!sent) {
        const blocked = await deps.store.markBlocked(reminder.id, {
          at: now,
          message: `${botDisplayLabel(reminder.delivery.platform)} 通道不可用，计划提醒没有投递。`,
          blockReason: 'bot_delivery_unavailable',
        });
        deps.emitChanged('blocked', blocked);
        return;
      }
      const triggered = await deps.store.markTriggered(reminder.id, {
        at: now,
        status: 'triggered',
        message: `已投递到 ${botDisplayLabel(reminder.delivery.platform)}。`,
      });
      deps.emitChanged('triggered', triggered);
      deps.emitDue(triggered);
      return;
    }

    const triggered = await deps.store.markTriggered(reminder.id, {
      at: now,
      status: 'triggered',
      message: '提醒已触发。',
    });
    deps.emitChanged('triggered', triggered);
    deps.emitDue(triggered);
  }

  return {
    list: () => deps.store.list(),
    async create(input) {
      const reminder = await deps.store.create(input);
      schedule(reminder);
      deps.emitChanged('created', reminder);
      return reminder;
    },
    async update(id, patch) {
      const reminder = await deps.store.update(id, patch);
      schedule(reminder);
      deps.emitChanged('updated', reminder);
      return reminder;
    },
    async setEnabled(id, enabled) {
      const reminder = await deps.store.setEnabled(id, enabled);
      schedule(reminder);
      deps.emitChanged('updated', reminder);
      return reminder;
    },
    async triggerNow(id) {
      const reminder = (await deps.store.list()).find((entry) => entry.id === id);
      if (!reminder) throw new Error(`No such plan reminder: ${id}`);
      if (!reminder.enabled) throw new Error('计划提醒已暂停，不能立即触发。');
      const now = Date.now();
      const privacy = await deps.getPrivacyContext();
      if (privacy.incognitoActive) {
        const blocked = await deps.store.markBlocked(reminder.id, {
          at: now,
          message: '隐私模式已开启，计划提醒没有触发。',
          blockReason: 'incognito_active',
        });
        schedule(blocked);
        deps.emitChanged('blocked', blocked);
        return blocked;
      }
      await deliver(reminder, now);
      const updated = (await deps.store.list()).find((entry) => entry.id === id);
      if (!updated) throw new Error(`No such plan reminder: ${id}`);
      schedule(updated);
      return updated;
    },
    async snooze(id) {
      const reminder = await deps.store.snooze(id, PLAN_REMINDER_DEFAULT_SNOOZE_MS);
      schedule(reminder);
      deps.emitChanged('updated', reminder);
      return reminder;
    },
    async clearRunHistory(id) {
      const reminder = await deps.store.clearRunHistory(id);
      schedule(reminder);
      deps.emitChanged('updated', reminder);
      return reminder;
    },
    async delete(id) {
      clearTimer(id);
      await deps.store.remove(id);
      deps.emitChanged('deleted', { id });
    },
    refreshTimers,
    stopTimers,
  };
}
