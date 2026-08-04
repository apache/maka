import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  createPlanReminderSchedule,
  isPlanReminderDue,
  nextPlanReminderStateAfterTrigger,
  nextPlanReminderRunAtAfter,
  normalizeCreatePlanReminderInput,
  normalizePlanReminderCronExpression,
  normalizePlanReminderDeliveryTarget,
  normalizeUpdatePlanReminderInput,
  planReminderScheduleStartAt,
  type PlanReminder,
  type PlanReminderRunRecord,
} from '@maka/core/plan-reminders';
import {
  acquireOperationalStateDatabase,
  completeOperationalStoreCutover,
  type OperationalStateDatabaseLease,
  type OperationalStoreCutoverFailpoint,
} from './operational-state-store.js';

export interface PlanReminderStore {
  list(): Promise<PlanReminder[]>;
  create(input: unknown): Promise<PlanReminder>;
  update(id: string, patch: unknown): Promise<PlanReminder>;
  setEnabled(id: string, enabled: boolean): Promise<PlanReminder>;
  snooze(id: string, delayMs: number, now?: number): Promise<PlanReminder>;
  clearRunHistory(id: string): Promise<PlanReminder>;
  remove(id: string): Promise<void>;
  listDue(now?: number): Promise<PlanReminder[]>;
  markTriggered(
    id: string,
    run: Omit<PlanReminderRunRecord, 'id'> & { id?: string },
  ): Promise<PlanReminder>;
  markBlocked(
    id: string,
    run: Omit<PlanReminderRunRecord, 'id' | 'status'> & { id?: string },
  ): Promise<PlanReminder>;
}

export function createPlanReminderStore(workspaceRoot: string): PlanReminderStore {
  return new FilePlanReminderStore(workspaceRoot);
}

export interface SqlitePlanReminderStore extends PlanReminderStore {
  ready(): Promise<void>;
  close(): void;
}

export interface CreateSqlitePlanReminderStoreOptions {
  failpoint?: (point: OperationalStoreCutoverFailpoint) => void;
}

export function createSqlitePlanReminderStore(
  workspaceRoot: string,
  options: CreateSqlitePlanReminderStoreOptions = {},
): SqlitePlanReminderStore {
  return new SqlitePlanReminderStoreImpl(workspaceRoot, options);
}

class FilePlanReminderStore implements PlanReminderStore {
  private readonly filePath: string;
  private queue: Promise<void> = Promise.resolve();

  constructor(workspaceRoot: string) {
    this.filePath = join(workspaceRoot, 'plan-reminders.json');
  }

  async list(): Promise<PlanReminder[]> {
    const reminders = await this.read();
    return reminders
      .filter((reminder) => reminder.status !== 'completed' || reminder.lastRun)
      .sort(comparePlanRemindersForList);
  }

  async create(input: unknown): Promise<PlanReminder> {
    const now = Date.now();
    const normalized = normalizeCreatePlanReminderInput(input, now);
    if (!normalized.ok) throw new Error(normalized.message);
    const value = normalized.value;
    const reminder: PlanReminder = {
      id: randomUUID(),
      title: value.title,
      note: value.note,
      schedule: value.schedule,
      delivery: value.delivery,
      status: 'scheduled',
      enabled: true,
      createdAt: now,
      updatedAt: now,
      nextRunAt: value.nextRunAt,
      runs: [],
      runCount: 0,
    };
    await this.mutate((reminders) => [...reminders, reminder]);
    return reminder;
  }

  async update(id: string, patch: unknown): Promise<PlanReminder> {
    const now = Date.now();
    const normalized = normalizeUpdatePlanReminderInput(patch, now);
    if (!normalized.ok) throw new Error(normalized.message);
    let updated: PlanReminder | undefined;
    await this.mutate((reminders) =>
      reminders.map((reminder) => {
        if (reminder.id !== id) return reminder;
        const nextEnabled = normalized.value.enabled ?? reminder.enabled;
        const nextRunAt = normalized.value.runAt ?? planReminderScheduleStartAt(reminder.schedule);
        const nextRecurrence =
          normalized.value.recurrence ??
          (reminder.schedule.kind === 'recurring'
            ? reminder.schedule.recurrence
            : reminder.schedule.kind === 'cron'
              ? 'cron'
              : 'none');
        const nextCronExpression =
          normalized.value.cronExpression ??
          (reminder.schedule.kind === 'cron' ? reminder.schedule.expression : undefined);
        const scheduleChanged =
          normalized.value.runAt !== undefined ||
          normalized.value.recurrence !== undefined ||
          normalized.value.cronExpression !== undefined;
        const nextSchedule = createPlanReminderSchedule(
          nextRunAt,
          nextRecurrence,
          nextCronExpression,
        );
        const nextScheduledRunAt = nextPlanReminderRunAtAfter(nextSchedule, now);
        if ((nextEnabled || scheduleChanged) && typeof nextScheduledRunAt !== 'number') {
          throw new Error('Plan reminder schedule has no run within one year');
        }
        updated = {
          ...reminder,
          ...(normalized.value.title !== undefined ? { title: normalized.value.title } : {}),
          ...(normalized.value.note !== undefined ? { note: normalized.value.note } : {}),
          ...(normalized.value.delivery !== undefined
            ? { delivery: normalized.value.delivery }
            : {}),
          schedule: nextSchedule,
          enabled: nextEnabled,
          status: nextEnabled ? 'scheduled' : 'paused',
          nextRunAt: nextEnabled ? nextScheduledRunAt : undefined,
          updatedAt: now,
        };
        return updated;
      }),
    );
    if (!updated) throw new Error(`No such plan reminder: ${id}`);
    return updated;
  }

  async setEnabled(id: string, enabled: boolean): Promise<PlanReminder> {
    if (typeof enabled !== 'boolean') throw new Error('Plan reminder enabled must be a boolean');
    const now = Date.now();
    let updated: PlanReminder | undefined;
    await this.mutate((reminders) =>
      reminders.map((reminder) => {
        if (reminder.id !== id) return reminder;
        if (reminder.status === 'completed') {
          updated = reminder;
          return reminder;
        }
        const nextRunAt = enabled ? nextPlanReminderResumeRunAt(reminder.schedule, now) : undefined;
        if (enabled && typeof nextRunAt !== 'number') {
          throw new Error('Plan reminder schedule has no run within one year');
        }
        updated = {
          ...reminder,
          enabled,
          status: enabled ? 'scheduled' : 'paused',
          nextRunAt,
          updatedAt: now,
        };
        return updated;
      }),
    );
    if (!updated) throw new Error(`No such plan reminder: ${id}`);
    return updated;
  }

  async snooze(id: string, delayMs: number, now = Date.now()): Promise<PlanReminder> {
    if (!Number.isFinite(delayMs) || delayMs <= 0 || delayMs > 7 * 24 * 60 * 60 * 1000) {
      throw new Error('Plan reminder snooze delay must be between 1 ms and 7 days');
    }
    let updated: PlanReminder | undefined;
    await this.mutate((reminders) =>
      reminders.map((reminder) => {
        if (reminder.id !== id) return reminder;
        if (
          !reminder.enabled ||
          reminder.status !== 'scheduled' ||
          typeof reminder.nextRunAt !== 'number'
        ) {
          throw new Error('Only scheduled plan reminders can be snoozed');
        }
        const base = Math.max(now, reminder.nextRunAt);
        updated = {
          ...reminder,
          nextRunAt: base + Math.floor(delayMs),
          status: 'scheduled',
          enabled: true,
          updatedAt: now,
        };
        return updated;
      }),
    );
    if (!updated) throw new Error(`No such plan reminder: ${id}`);
    return updated;
  }

  async clearRunHistory(id: string): Promise<PlanReminder> {
    const now = Date.now();
    let updated: PlanReminder | undefined;
    await this.mutate((reminders) =>
      reminders.map((reminder) => {
        if (reminder.id !== id) return reminder;
        if (reminder.status === 'completed') {
          throw new Error(
            'Completed plan reminder history cannot be cleared; delete the reminder instead',
          );
        }
        updated = {
          ...reminder,
          lastRun: undefined,
          runs: [],
          updatedAt: now,
        };
        return updated;
      }),
    );
    if (!updated) throw new Error(`No such plan reminder: ${id}`);
    return updated;
  }

  async remove(id: string): Promise<void> {
    let found = false;
    await this.mutate((reminders) =>
      reminders.filter((reminder) => {
        if (reminder.id === id) {
          found = true;
          return false;
        }
        return true;
      }),
    );
    if (!found) throw new Error(`No such plan reminder: ${id}`);
  }

  async listDue(now = Date.now()): Promise<PlanReminder[]> {
    return (await this.read()).filter((reminder) => isPlanReminderDue(reminder, now));
  }

  async markTriggered(
    id: string,
    run: Omit<PlanReminderRunRecord, 'id'> & { id?: string },
  ): Promise<PlanReminder> {
    let updated: PlanReminder | undefined;
    await this.mutate((reminders) =>
      reminders.map((reminder) => {
        if (reminder.id !== id) return reminder;
        const record: PlanReminderRunRecord = {
          id: run.id ?? randomUUID(),
          at: run.at,
          status: 'triggered',
          message: run.message,
        };
        updated = nextPlanReminderStateAfterTrigger(reminder, record);
        return updated;
      }),
    );
    if (!updated) throw new Error(`No such plan reminder: ${id}`);
    return updated;
  }

  async markBlocked(
    id: string,
    run: Omit<PlanReminderRunRecord, 'id' | 'status'> & { id?: string },
  ): Promise<PlanReminder> {
    let updated: PlanReminder | undefined;
    await this.mutate((reminders) =>
      reminders.map((reminder) => {
        if (reminder.id !== id) return reminder;
        const record: PlanReminderRunRecord = {
          id: run.id ?? randomUUID(),
          at: run.at,
          status: 'blocked',
          message: run.message,
          ...(run.blockReason ? { blockReason: run.blockReason } : {}),
        };
        updated = nextPlanReminderStateAfterTrigger(reminder, record);
        return updated;
      }),
    );
    if (!updated) throw new Error(`No such plan reminder: ${id}`);
    return updated;
  }

  private async read(): Promise<PlanReminder[]> {
    const canonical = await this.readCanonical();
    if (canonical) return canonical;
    try {
      const text = await readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(text) as unknown;
      if (!Array.isArray(parsed)) {
        throw new Error('Invalid plan reminders file: expected an array');
      }
      return parsed.map((value, index) => normalizePersistedPlanReminder(value, index));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  private async mutate(fn: (reminders: PlanReminder[]) => PlanReminder[]): Promise<void> {
    const run = async () => {
      const current = await this.read();
      await this.write(fn(current));
    };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => {});
    await next;
  }

  private async write(reminders: PlanReminder[]): Promise<void> {
    if (await this.writeCanonical(reminders)) return;
    await mkdir(dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tempPath, JSON.stringify(reminders, null, 2) + '\n', 'utf8');
    await rename(tempPath, this.filePath);
  }

  protected async readCanonical(): Promise<PlanReminder[] | undefined> {
    return undefined;
  }

  protected async writeCanonical(_reminders: PlanReminder[]): Promise<boolean> {
    return false;
  }
}

class SqlitePlanReminderStoreImpl extends FilePlanReminderStore implements SqlitePlanReminderStore {
  readonly #lease: OperationalStateDatabaseLease;
  readonly #ready: Promise<void>;

  constructor(workspaceRoot: string, options: CreateSqlitePlanReminderStoreOptions) {
    super(workspaceRoot);
    const root = resolve(workspaceRoot);
    this.#lease = acquireOperationalStateDatabase(root);
    this.#ready = importLegacyPlanReminders(root, this.#lease, options.failpoint);
  }

  ready(): Promise<void> {
    return this.#ready;
  }

  close(): void {
    this.#lease.close();
  }

  protected override async readCanonical(): Promise<PlanReminder[]> {
    await this.#ready;
    return readSqlitePlanReminders(this.#lease.database);
  }

  protected override async writeCanonical(reminders: PlanReminder[]): Promise<boolean> {
    await this.#ready;
    this.#lease.transaction('write', () => {
      this.#lease.database.prepare('DELETE FROM workflow_plan_reminders').run();
      for (const reminder of reminders) insertPlanReminder(this.#lease.database, reminder);
    });
    return true;
  }
}

async function importLegacyPlanReminders(
  root: string,
  lease: OperationalStateDatabaseLease,
  failpoint?: (point: OperationalStoreCutoverFailpoint) => void,
): Promise<void> {
  let reminders: PlanReminder[] = [];
  const sourcePath = join(root, 'plan-reminders.json');
  try {
    const parsed = JSON.parse(await readFile(sourcePath, 'utf8')) as unknown;
    if (!Array.isArray(parsed)) {
      throw new Error('Invalid plan reminders file: expected an array');
    }
    reminders = parsed.map((value, index) => normalizePersistedPlanReminder(value, index));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const fingerprint = `sha256:${createHash('sha256')
    .update(JSON.stringify(reminders))
    .digest('hex')}`;
  completeOperationalStoreCutover(lease, {
    storeName: 'workflow_plan_reminders',
    sourcePath,
    sourceFingerprint: fingerprint,
    failpoint,
    importAndValidate: (database) => {
      for (const reminder of reminders) insertOrValidatePlanReminder(database, reminder);
      const persisted = database
        .prepare('SELECT COUNT(*) AS count FROM workflow_plan_reminders')
        .get() as { count?: unknown };
      if (persisted.count !== reminders.length) {
        throw new Error('Plan reminder cutover row-count validation failed');
      }
      return { reminders: reminders.length };
    },
  });
}

function readSqlitePlanReminders(database: DatabaseSync): PlanReminder[] {
  const rows = database
    .prepare(`
      SELECT record_json
      FROM workflow_plan_reminders
      ORDER BY created_at, reminder_id
    `)
    .all() as Array<{ record_json?: unknown }>;
  return rows.map((row, index) => {
    if (typeof row.record_json !== 'string') {
      throw new Error(`Invalid SQLite plan reminder at row ${index + 1}`);
    }
    return normalizePersistedPlanReminder(JSON.parse(row.record_json), index);
  });
}

function insertPlanReminder(database: DatabaseSync, reminder: PlanReminder): void {
  database
    .prepare(`
      INSERT INTO workflow_plan_reminders(
        reminder_id, created_at, updated_at, record_json
      ) VALUES (?, ?, ?, ?)
    `)
    .run(reminder.id, reminder.createdAt, reminder.updatedAt, JSON.stringify(reminder));
}

function insertOrValidatePlanReminder(database: DatabaseSync, reminder: PlanReminder): void {
  const existing = database
    .prepare('SELECT record_json FROM workflow_plan_reminders WHERE reminder_id = ?')
    .get(reminder.id) as { record_json?: unknown } | undefined;
  if (existing) {
    if (existing.record_json !== JSON.stringify(reminder)) {
      throw new Error(`Plan reminder cutover conflict: ${reminder.id}`);
    }
    return;
  }
  insertPlanReminder(database, reminder);
}

function comparePlanRemindersForList(a: PlanReminder, b: PlanReminder): number {
  const statusDelta = planReminderListPriority(a) - planReminderListPriority(b);
  if (statusDelta !== 0) return statusDelta;
  if (a.status === 'completed' && b.status === 'completed') {
    const aTime = a.lastRun?.at ?? a.updatedAt;
    const bTime = b.lastRun?.at ?? b.updatedAt;
    const delta = bTime - aTime;
    return delta === 0 ? a.id.localeCompare(b.id) : delta;
  }
  const aTime = a.nextRunAt ?? planReminderScheduleStartAt(a.schedule) ?? a.updatedAt;
  const bTime = b.nextRunAt ?? planReminderScheduleStartAt(b.schedule) ?? b.updatedAt;
  const delta = aTime - bTime;
  return delta === 0 ? a.id.localeCompare(b.id) : delta;
}

function planReminderListPriority(reminder: PlanReminder): number {
  if (reminder.status === 'scheduled') return 0;
  if (reminder.status === 'paused') return 1;
  return 2;
}

function nextPlanReminderResumeRunAt(
  schedule: PlanReminder['schedule'],
  now: number,
): number | undefined {
  const nextRunAt = nextPlanReminderRunAtAfter(schedule, now);
  if (typeof nextRunAt === 'number') return nextRunAt;
  if (schedule.kind === 'once') return schedule.runAt;
  return undefined;
}

function normalizePersistedPlanReminder(value: unknown, index: number): PlanReminder {
  const invalid = (reason: string): never => {
    throw new Error(`Invalid plan reminders file: entry ${index + 1} ${reason}`);
  };
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    invalid('is not an object');
  }
  const record = value as Partial<PlanReminder>;
  const valid =
    typeof record.id === 'string' &&
    typeof record.title === 'string' &&
    typeof record.note === 'string' &&
    isPersistedPlanReminderSchedule(record.schedule) &&
    (record.status === 'scheduled' ||
      record.status === 'paused' ||
      record.status === 'completed') &&
    typeof record.enabled === 'boolean' &&
    typeof record.createdAt === 'number' &&
    typeof record.updatedAt === 'number' &&
    typeof record.runCount === 'number';
  if (!valid) invalid('is malformed');
  const delivery = normalizePlanReminderDeliveryTarget((record as { delivery?: unknown }).delivery);
  const deliveryValue = delivery.ok ? delivery.value : invalid('has invalid delivery');
  const runs: PlanReminderRunRecord[] = [];
  if (record.runs !== undefined) {
    if (!Array.isArray(record.runs)) invalid('has malformed runs');
    for (const [runIndex, run] of record.runs.entries()) {
      if (!isPersistedPlanReminderRunRecord(run)) {
        invalid(`has malformed run record ${runIndex + 1}`);
      }
      runs.push(run);
    }
  }
  if (record.lastRun !== undefined && !isPersistedPlanReminderRunRecord(record.lastRun)) {
    invalid('has malformed lastRun');
  }
  if (runs.length === 0 && record.lastRun !== undefined) {
    runs.push(record.lastRun);
  }
  return {
    ...record,
    schedule: record.schedule,
    delivery: deliveryValue,
    runs,
    ...(isPersistedPlanReminderRunRecord(record.lastRun)
      ? { lastRun: record.lastRun }
      : runs[0]
        ? { lastRun: runs[0] }
        : {}),
  } as PlanReminder;
}

function isPersistedPlanReminderSchedule(value: unknown): value is PlanReminder['schedule'] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Partial<PlanReminder['schedule']>;
  if (record.kind === 'once') {
    return typeof (record as { runAt?: unknown }).runAt === 'number';
  }
  if (record.kind === 'recurring') {
    const recurrence = (record as { recurrence?: unknown }).recurrence;
    return (
      typeof (record as { startAt?: unknown }).startAt === 'number' &&
      (recurrence === 'daily' || recurrence === 'weekly' || recurrence === 'monthly')
    );
  }
  if (record.kind === 'cron') {
    const expression = (record as { expression?: unknown }).expression;
    return (
      typeof (record as { startAt?: unknown }).startAt === 'number' &&
      normalizePlanReminderCronExpression(expression).ok
    );
  }
  return false;
}

function isPersistedPlanReminderRunRecord(value: unknown): value is PlanReminderRunRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Partial<PlanReminderRunRecord>;
  return (
    typeof record.id === 'string' &&
    typeof record.at === 'number' &&
    (record.status === 'triggered' || record.status === 'blocked' || record.status === 'failed') &&
    typeof record.message === 'string' &&
    (record.blockReason === undefined ||
      record.blockReason === 'incognito_active' ||
      record.blockReason === 'bot_delivery_unavailable')
  );
}
