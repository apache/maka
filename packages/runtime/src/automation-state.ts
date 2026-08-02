/**
 * Unified Automation — Codex-style automation system.
 *
 * Two kinds:
 * - "heartbeat": session-scoped polling (resume into same session)
 * - "cron": standalone scheduled runs (create fresh session each time)
 */

import type {
  AutomationDefinition,
  AutomationExecutionTemplate,
  AutomationKind,
  AutomationSchedule,
} from '@maka/core/automation';
import { AUTOMATION_LAST_ERROR_LIMIT, truncateAutomationText } from '@maka/core/automation';

export type {
  AutomationDefinition,
  AutomationExecutionTemplate,
  AutomationKind,
  AutomationSchedule,
  AutomationStatus,
} from '@maka/core/automation';

export interface AutomationManagerDeps {
  generateId: () => string;
  now: () => number;
  /** Randomness source for schedule jitter. Injectable for deterministic tests. */
  random?: () => number;
}

const MAX_AUTOMATIONS_PER_SESSION = 20;
const MAX_CONSECUTIVE_FAILURES = 5;
const DEFAULT_EXPIRY_DAYS = 7;
const DEFAULT_AUTOMATION_FAILURE_MESSAGE = 'Automation run failed';

/** Maximum jitter cap for recurring re-schedules: 15 minutes. */
const MAX_JITTER_MS = 15 * 60 * 1000;

/** Maximum early jitter for one-shot fires landing on round minutes: 90 seconds. */
const ONE_SHOT_JITTER_MS = 90 * 1000;

/**
 * Thundering-herd jitter, ported verbatim from the old wakeup-scheduler.
 *
 * - Recurring (interval/cron): up to 10% of the delay, capped at 15 minutes.
 * - One-shot firing on :00 or :30: up to 90s early jitter (returned as
 *   negative). Otherwise 0 for one-shot. The round-mark property belongs to
 *   the ACTUAL fire timestamp, not the delay (a 30-minute delay from 10:07
 *   fires at 10:37 — no round mark).
 */
export function computeJitter(
  delayMs: number,
  recurring: boolean,
  random: () => number = Math.random,
  firesAtMs?: number,
): number {
  if (recurring) {
    const maxJitter = Math.min(delayMs * 0.1, MAX_JITTER_MS);
    return Math.floor(random() * maxJitter);
  }
  if (firesAtMs !== undefined && new Date(firesAtMs).getMinutes() % 30 === 0) {
    return -Math.floor(random() * ONE_SHOT_JITTER_MS);
  }
  return 0;
}

export class AutomationManager {
  private automations = new Map<string, AutomationDefinition>();

  constructor(private readonly deps: AutomationManagerDeps) {}

  create(input: {
    kind: AutomationKind;
    name: string;
    prompt: string;
    sessionId: string;
    schedule: AutomationSchedule;
    maxFires?: number;
    expiresAt?: number;
    durable?: boolean;
    execution?: AutomationExecutionTemplate;
  }): AutomationDefinition | { error: string } {
    // Only count active/paused automations toward the limit (not completed/expired).
    const activeCount = this.listForSession(input.sessionId).filter(
      (a) => a.status === 'active' || a.status === 'paused',
    ).length;
    if (activeCount >= MAX_AUTOMATIONS_PER_SESSION) {
      return {
        error: `Maximum ${MAX_AUTOMATIONS_PER_SESSION} active automations per session reached.`,
      };
    }

    if (input.kind === 'heartbeat') {
      const existing = this.listForSession(input.sessionId).filter(
        (a) => a.kind === 'heartbeat' && a.status === 'active',
      );
      if (existing.length >= 5) {
        return { error: 'Maximum 5 active heartbeat automations per session.' };
      }
    }

    const now = this.deps.now();
    const id = this.deps.generateId();
    const nextFireAt = this.computeNextFire(input.schedule, now);

    if (nextFireAt === null && input.schedule.type === 'cron') {
      return {
        error: `Invalid cron expression: "${input.schedule.expression}". Could not compute next fire time.`,
      };
    }

    const defaultExpiry = now + DEFAULT_EXPIRY_DAYS * 24 * 60 * 60 * 1000;

    // Cron is a standalone scheduled task (fresh session each run) — it is
    // meaningless if it dies on restart, so it defaults to durable. Heartbeat
    // injects into its own session and has no coherent post-restart target, so
    // it is ALWAYS session-bound (never durable) — a durable heartbeat would be
    // a zombie after restart. `durable` is therefore a cron-only concept; an
    // explicit value only refines cron.
    const durable = input.kind === 'cron' ? (input.durable ?? true) : false;

    const automation: AutomationDefinition = {
      id,
      kind: input.kind,
      name: input.name,
      status: 'active',
      prompt: input.prompt,
      sessionId: input.sessionId,
      schedule: input.schedule,
      createdAt: now,
      updatedAt: now,
      nextFireAt,
      lastFireAt: null,
      lastRunId: null,
      fireCount: 0,
      maxFires: input.maxFires ?? null,
      expiresAt: input.expiresAt ?? defaultExpiry,
      lastError: null,
      consecutiveFailures: 0,
      ...(durable ? { durable: true } : {}),
      ...(input.kind === 'cron' && input.execution ? { execution: input.execution } : {}),
    };

    this.automations.set(id, automation);
    this.pruneTerminal(input.sessionId);
    return automation;
  }

  get(id: string): AutomationDefinition | undefined {
    return this.automations.get(id);
  }

  delete(id: string, sessionId?: string): boolean {
    const automation = this.automations.get(id);
    if (!automation) return false;
    if (sessionId && !this.manageableBy(automation, sessionId)) return false;
    this.automations.delete(id);
    return true;
  }

  pause(id: string, sessionId: string): AutomationDefinition | undefined {
    const automation = this.automations.get(id);
    if (!automation || !this.manageableBy(automation, sessionId)) return undefined;
    if (automation.status !== 'active') return undefined;
    automation.status = 'paused';
    automation.updatedAt = this.deps.now();
    return automation;
  }

  resume(id: string, sessionId: string): AutomationDefinition | undefined {
    const automation = this.automations.get(id);
    if (!automation || !this.manageableBy(automation, sessionId)) return undefined;
    if (automation.status !== 'paused') return undefined;
    // Refuse to resume an automation whose fire budget is already spent. A
    // maxFires-exhausted (or a one-shot that already fired) automation only
    // reaches 'paused' via the attemptFailed path, which leaves nextFireAt=null.
    // Re-arming it here would grant a fire beyond the declared hard cap — the
    // next tick would bump fireCount past maxFires (or re-fire a 'once'),
    // spawning a real extra run. maxFires is a cap on ATTEMPTS, so a spent
    // budget cannot be revived by resume.
    if (automation.maxFires && automation.fireCount >= automation.maxFires) return undefined;
    if (automation.schedule.type === 'once' && automation.fireCount > 0) return undefined;
    automation.status = 'active';
    automation.updatedAt = this.deps.now();
    // Resume starts a clean streak — a fire that paused this automation must not
    // count toward re-pausing it after a single fresh failure.
    automation.consecutiveFailures = 0;
    automation.lastError = null;
    automation.nextFireAt = this.computeNextFire(automation.schedule, this.deps.now());
    return automation;
  }

  listForSession(sessionId: string): AutomationDefinition[] {
    return [...this.automations.values()].filter((a) => a.sessionId === sessionId);
  }

  /**
   * Automations a session can see and manage: its own (any kind) plus every
   * durable one. Durable automations (cron by default) are app-global — they
   * outlive their creator session and reload from disk on restart with their
   * original sessionId, so a fresh session must still be able to list and
   * manage them. Non-durable heartbeats stay private to their session.
   */
  listVisibleForSession(sessionId: string): AutomationDefinition[] {
    return [...this.automations.values()].filter(
      (a) => a.sessionId === sessionId || a.durable === true,
    );
  }

  /** A session may manage its own automations plus any durable (app-global) one. */
  private manageableBy(automation: AutomationDefinition, sessionId: string): boolean {
    return automation.sessionId === sessionId || automation.durable === true;
  }

  listActive(): AutomationDefinition[] {
    return [...this.automations.values()].filter((a) => a.status === 'active');
  }

  /**
   * Mark an expired automation terminal. Returns true if it was expired.
   * Used by the scheduler's eager expiry sweep.
   */
  sweepExpired(id: string): boolean {
    const automation = this.automations.get(id);
    if (!automation || automation.status !== 'active') return false;
    const now = this.deps.now();
    if (automation.expiresAt && now >= automation.expiresAt) {
      automation.status = 'expired';
      automation.nextFireAt = null;
      automation.updatedAt = now;
      return true;
    }
    return false;
  }

  /**
   * Begin a fire attempt: advance the schedule and counters, but do NOT commit
   * terminal completion — that happens only on a real success (attemptSucceeded).
   * Checks expiry first. Returns the automation if it should fire, else undefined.
   */
  attemptStarted(id: string): AutomationDefinition | undefined {
    const automation = this.automations.get(id);
    if (!automation || automation.status !== 'active') return undefined;

    const now = this.deps.now();
    // Check expiry BEFORE firing — don't execute expired automations.
    if (automation.expiresAt && now >= automation.expiresAt) {
      automation.status = 'expired';
      automation.nextFireAt = null;
      automation.updatedAt = now;
      return undefined;
    }

    automation.lastFireAt = now;
    automation.fireCount++;
    automation.updatedAt = now;

    // A one-shot does not auto-retry: null its nextFireAt now. A recurring job
    // advances to its next slot. Completion (once / maxFires) is committed only
    // after a successful outcome in attemptSucceeded.
    automation.nextFireAt =
      automation.schedule.type === 'once' ? null : this.computeNextFire(automation.schedule, now);

    // maxFires is a hard cap on the number of fire ATTEMPTS: once this attempt
    // reaches the cap, no further fire is scheduled — regardless of whether this
    // one ultimately succeeds or fails. (Terminal status is still committed by
    // attemptSucceeded/attemptFailed based on this attempt's outcome.) Without
    // this, a failing recurring automation would keep firing past maxFires until
    // the consecutive-failure cap, and fireCount could exceed maxFires.
    if (automation.maxFires && automation.fireCount >= automation.maxFires) {
      automation.nextFireAt = null;
    }

    return automation;
  }

  /**
   * Record a fire attempt deferred by the idle-gate (target busy). Pure
   * observability — surfaced in the model-facing list output.
   */
  recordDeferredFire(id: string): void {
    const automation = this.automations.get(id);
    if (!automation || automation.status !== 'active') return;
    automation.deferredFireCount = (automation.deferredFireCount ?? 0) + 1;
  }

  /**
   * Skip a fire without executing — advance to next schedule time.
   * Used only when the scheduler's defer/retry window (~45min, mirroring the
   * old wakeup-scheduler's exponential-backoff budget) is exhausted — never on
   * a transient busy blip.
   */
  skipFire(id: string): void {
    const automation = this.automations.get(id);
    if (!automation || automation.status !== 'active') return;
    const now = this.deps.now();
    automation.updatedAt = now;
    // A one-shot has no "next slot": re-arming it via computeNextFire re-adds the
    // full delay, so repeated skips (e.g. a long incognito window or a busy
    // session) would drift it forward indefinitely and then silently drop it at
    // expiry. Its fire window has passed — settle it terminally instead.
    if (automation.schedule.type === 'once') {
      automation.nextFireAt = null;
      automation.status = 'expired';
      automation.lastError = 'Fire window skipped (session busy or privacy mode)';
      return;
    }
    automation.nextFireAt = this.computeNextFire(automation.schedule, now);
  }

  /**
   * Commit a successful fire outcome: reset failure state, record the run id,
   * and NOW apply completion (once / maxFires reached).
   */
  attemptSucceeded(id: string, runId?: string): void {
    const automation = this.automations.get(id);
    if (!automation) return;
    settleAutomationAttempt(automation, { status: 'completed', runId }, this.deps.now());
  }

  /**
   * Record a failed fire outcome. Accumulates toward the consecutive-failure
   * cap (→ paused). A one-shot that fails has no next fire, so it is paused so
   * it is visible rather than a silent idle zombie.
   */
  attemptFailed(id: string, error: string): void {
    const automation = this.automations.get(id);
    if (!automation) return;
    settleAutomationAttempt(automation, { status: 'failed', error }, this.deps.now());
  }

  removeAllForSession(sessionId: string): number {
    let count = 0;
    for (const [id, auto] of this.automations) {
      if (auto.sessionId === sessionId && auto.kind === 'heartbeat') {
        this.automations.delete(id);
        count++;
      }
    }
    return count;
  }

  dispose(): void {
    this.automations.clear();
  }

  /** Bulk-register pre-existing automations (e.g. loaded from durable store on startup). */
  registerAll(automations: AutomationDefinition[]): void {
    const now = this.deps.now();
    for (const automation of automations) {
      // Reconcile an interrupted fire: a fire that started (fireCount bumped,
      // nextFireAt nulled) but whose run never settled — the app quit mid-run —
      // persists as active with nextFireAt=null. Left alone it is a silent
      // zombie (never fires again until the 7-day expiry sweep).
      if (automation.status === 'active' && automation.nextFireAt === null) {
        const budgetSpent =
          (automation.maxFires != null && automation.fireCount >= automation.maxFires) ||
          (automation.schedule.type === 'once' && automation.fireCount > 0);
        if (budgetSpent) {
          // The one/last fire was already attempted (fireCount reflects it), so
          // settle it terminally rather than re-run it (at-most-once semantics).
          // Its outcome was never committed, so record the uncertainty instead of
          // asserting a clean success — a genuine success leaves lastError null.
          automation.status = 'completed';
          automation.lastError =
            'Interrupted on restart before the fire outcome was recorded; not re-run.';
        } else {
          // A recurring automation should always carry a future fire time; a null
          // here is a corrupt/interrupted state — re-arm it.
          automation.nextFireAt = this.computeNextFire(automation.schedule, now);
        }
      }
      this.automations.set(automation.id, automation);
    }
  }

  /** Replace the projection without applying legacy restart reconciliation. */
  hydrate(automations: readonly AutomationDefinition[]): void {
    this.automations.clear();
    for (const automation of automations) {
      this.automations.set(automation.id, structuredClone(automation));
    }
  }

  /** Return all automations (all statuses, all sessions). */
  listAll(): AutomationDefinition[] {
    return [...this.automations.values()];
  }

  /** Remove completed/expired automations beyond a grace buffer (matches the
   *  old wakeup-scheduler's MAX_RECORDS_PER_SESSION=50 observable history). */
  private pruneTerminal(sessionId: string): void {
    const terminal = this.listForSession(sessionId).filter(
      (a) => a.status === 'completed' || a.status === 'expired',
    );
    const MAX_TERMINAL_KEPT = 50;
    if (terminal.length <= MAX_TERMINAL_KEPT) return;
    terminal.sort((a, b) => a.updatedAt - b.updatedAt);
    for (let i = 0; i < terminal.length - MAX_TERMINAL_KEPT; i++) {
      this.automations.delete(terminal[i].id);
    }
  }

  /**
   * Next fire time with thundering-herd jitter (see computeJitter):
   * - once: base delay; if the fire lands on a :00/:30 wall-clock minute, pull
   *   it up to 90s EARLY (never before fromTime).
   * - interval/cron (recurring): push up to 10% of the delay late, capped at
   *   15min. Jitter is strictly non-negative for recurring schedules so a cron
   *   can never fire BEFORE its mark (an early cron fire would recompute the
   *   same mark next time and double-fire).
   */
  private computeNextFire(schedule: AutomationSchedule, fromTime: number): number | null {
    const random = this.deps.random ?? Math.random;
    switch (schedule.type) {
      case 'once': {
        const delayMs = schedule.delaySeconds * 1000;
        const base = fromTime + delayMs;
        return Math.max(fromTime, base + computeJitter(delayMs, false, random, base));
      }
      case 'interval': {
        const delayMs = schedule.seconds * 1000;
        return fromTime + delayMs + computeJitter(delayMs, true, random);
      }
      case 'cron': {
        const base = computeNextCronFire(schedule.expression, fromTime);
        if (base === null) return null;
        return base + computeJitter(base - fromTime, true, random);
      }
    }
  }
}

export type AutomationAttemptOutcome =
  | { readonly status: 'completed'; readonly runId?: string }
  | {
      readonly status: 'failed' | 'cancelled';
      readonly error: string;
      readonly runId?: string;
    };

/** Settle an attempt that was accepted while the definition was active. */
export function settleAutomationAttempt(
  automation: AutomationDefinition,
  outcome: AutomationAttemptOutcome,
  now: number,
): void {
  if (automation.status === 'completed' || automation.status === 'expired') return;
  if (outcome.runId) automation.lastRunId = outcome.runId;
  automation.updatedAt = now;
  if (outcome.status === 'completed') {
    automation.consecutiveFailures = 0;
    automation.lastError = null;
    if (
      automation.status === 'active' &&
      (automation.schedule.type === 'once' ||
        (automation.maxFires !== null && automation.fireCount >= automation.maxFires))
    ) {
      automation.status = 'completed';
      automation.nextFireAt = null;
    }
    return;
  }
  automation.consecutiveFailures += 1;
  const diagnostic = truncateAutomationText(outcome.error, AUTOMATION_LAST_ERROR_LIMIT);
  automation.lastError = diagnostic.length > 0 ? diagnostic : DEFAULT_AUTOMATION_FAILURE_MESSAGE;
  if (
    automation.status === 'active' &&
    (automation.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES || automation.nextFireAt === null)
  ) {
    automation.status = 'paused';
  }
}

const MINUTES_PER_DAY = 24 * 60;

/**
 * Upper bound on the minute-by-minute search window.
 *
 * A valid but sparse cron such as `0 0 29 2 *` (Feb 29, leap years only) can be
 * several years out. The maximum gap between two consecutive Feb 29ths is
 * 8 years: a century year that is not divisible by 400 (e.g. 2100, 2200) is NOT
 * a leap year, so the sequence 2096 -> 2104 skips 2100 entirely. Searching a
 * full ~8-year window guarantees every legally-satisfiable expression resolves,
 * while the bound still lets genuinely-impossible expressions (e.g.
 * `0 0 30 2 *`, Feb 30 never exists) terminate and return null instead of
 * looping forever.
 */
const MAX_SEARCH_MINUTES = 8 * 366 * MINUTES_PER_DAY; // ~8 years, bounded

const CRON_MONTH_ALIASES: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};
const CRON_DOW_ALIASES: Record<string, number> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
};
// Leap-year max days per month (Feb=29) — used only for impossible-date detection.
const CRON_MAX_DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/** Replace alphabetic cron tokens (e.g. MON, JAN) with their numeric value. */
function translateCronAliases(field: string, aliases: Record<string, number>): string {
  return field.replace(/[a-zA-Z]+/g, (tok) => {
    const n = aliases[tok.toLowerCase()];
    return n === undefined ? tok : String(n);
  });
}

/**
 * Expand a numeric cron field to the set of values it matches within [min,max].
 * Returns 'star' for "*", or null if any token is malformed or out of range.
 */
function expandCronField(field: string, min: number, max: number): number[] | 'star' | null {
  if (field === '*') return 'star';
  const values = new Set<number>();
  for (const part of field.split(',')) {
    let range = part;
    let step = 1;
    if (part.includes('/')) {
      const [r, s] = part.split('/');
      step = parseInt(s, 10);
      if (!Number.isInteger(step) || step <= 0) return null;
      range = r;
    }
    let lo: number;
    let hi: number;
    if (range === '*') {
      lo = min;
      hi = max;
    } else if (range.includes('-')) {
      const [a, b] = range.split('-');
      lo = parseInt(a, 10);
      hi = parseInt(b, 10);
      if (!Number.isInteger(lo) || !Number.isInteger(hi)) return null;
    } else {
      lo = parseInt(range, 10);
      if (!Number.isInteger(lo)) return null;
      hi = part.includes('/') ? max : lo; // "5/10" means 5,15,25… up to max
    }
    if (lo < min || hi > max || lo > hi) return null;
    for (let v = lo; v <= hi; v += step) values.add(v);
  }
  return [...values];
}

interface NormalizedCron {
  minuteField: string;
  hourField: string;
  domField: string;
  monthField: string;
  dowField: string;
}

/**
 * Validate + normalize a 5-field cron expression in O(1): translate named
 * day/month tokens to numbers, reject out-of-range values, and fast-fail
 * impossible calendar dates (e.g. Feb 30, Apr 31). Returns null for anything
 * malformed or unsatisfiable so the caller skips the expensive minute scan.
 */
function normalizeCronExpression(expression: string): NormalizedCron | null {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const minuteField = parts[0];
  const hourField = parts[1];
  const domField = parts[2];
  const monthField = translateCronAliases(parts[3], CRON_MONTH_ALIASES);
  const dowField = translateCronAliases(parts[4], CRON_DOW_ALIASES);

  if (expandCronField(minuteField, 0, 59) === null) return null;
  if (expandCronField(hourField, 0, 23) === null) return null;
  const domVals = expandCronField(domField, 1, 31);
  const monthVals = expandCronField(monthField, 1, 12);
  const dowVals = expandCronField(dowField, 0, 7); // 0 and 7 both = Sunday
  if (domVals === null || monthVals === null || dowVals === null) return null;

  // Impossible calendar date: only fast-fail when the day is constrained ONLY by
  // dom+month (dow="*"). If dow is also restricted, Vixie OR-semantics mean a
  // matching weekday can still fire, so we must NOT reject.
  if (domVals !== 'star' && monthVals !== 'star' && dowVals === 'star') {
    const maxDays = Math.max(...monthVals.map((m) => CRON_MAX_DAYS_IN_MONTH[m - 1]));
    if (Math.min(...domVals) > maxDays) return null; // e.g. Feb 30, Apr 31
  }

  return { minuteField, hourField, domField, monthField, dowField };
}

/**
 * Compute the next Unix-ms timestamp at which a 5-field cron expression fires,
 * strictly after `fromTime`. Returns null for a malformed expression or one
 * that cannot occur within the bounded search window.
 *
 * TIMEZONE CONTRACT: evaluation happens in the HOST's local timezone. Candidate
 * instants are decomposed with `Date` local getters (`getMinutes`, `getHours`,
 * `getDate`, `getMonth`, `getDay`), so `0 9 * * *` means "09:00 local wall-clock
 * time" on the machine running this process. Across DST transitions the wall
 * clock is respected (a skipped/repeated local hour shifts the fire instant
 * accordingly). There is no per-automation IANA timezone; if the process moves
 * timezones, schedules re-anchor to the new local time. Threading an explicit
 * IANA zone would ripple through the schedule type and every caller, so it is
 * intentionally out of scope for this parser.
 */
export function computeNextCronFire(expression: string, fromTime: number): number | null {
  // Validate + normalize BEFORE the bounded scan so an unsatisfiable or
  // unsupported expression fails in O(1) instead of blocking the (main-process)
  // thread for a multi-second full-window scan. This translates named tokens
  // (MON-SUN, JAN-DEC), rejects out-of-range values, and fast-fails impossible
  // calendar dates (e.g. Feb 30).
  const normalized = normalizeCronExpression(expression);
  if (!normalized) return null;
  const { minuteField, hourField, domField, monthField, dowField } = normalized;

  // Vixie-cron day semantics: when BOTH the day-of-month and day-of-week fields
  // are restricted (neither is "*"), a day matches if it satisfies EITHER field
  // (OR) — e.g. `0 0 13 * 5` fires on the 13th of any month OR on any Friday,
  // NOT only on Friday the 13th. When at least one field is "*", that field
  // matches every value, so the two are combined with AND (the "*" field is a
  // no-op and only the other constrains).
  const domIsStar = domField === '*';
  const dowIsStar = dowField === '*';
  const bothDayFieldsRestricted = !domIsStar && !dowIsStar;

  // Start the scan at the next whole-minute boundary strictly after fromTime,
  // computed in EPOCH arithmetic. Using Date.setSeconds() would round-trip the
  // instant through local wall-clock; during a DST fall-back (a repeated local
  // hour) V8 re-encodes the ambiguous time to the earlier offset, shifting the
  // start ~59 min BEFORE fromTime. The scan would then return a candidate
  // <= fromTime, breaking the strictly-after contract and making the scheduler
  // re-fire every tick for the whole repeated hour. Epoch math is offset-safe;
  // candidate wall-clock fields are still read with local getters below.
  const baseTime = fromTime - (fromTime % 60000) + 60000;

  for (let attempt = 0; attempt < MAX_SEARCH_MINUTES; attempt++) {
    const candidateTime = baseTime + attempt * 60000;
    const candidate = new Date(candidateTime);

    // Cheapest, most-selective checks first so most candidates are pruned before
    // the day-field matching runs.
    if (!matchesCronField(minuteField, candidate.getMinutes(), 0, 59)) continue;
    if (!matchesCronField(hourField, candidate.getHours(), 0, 23)) continue;
    if (!matchesCronField(monthField, candidate.getMonth() + 1, 1, 12)) continue;

    const domMatch = matchesCronField(domField, candidate.getDate(), 1, 31);
    // Day-of-week: cron allows both 0 and 7 for Sunday, but Date.getDay() only
    // returns 0-6 (0=Sunday). Match against the raw value, plus the 7-alias when
    // the day is Sunday, so fields like "7", "5-7", "0,7" all fire on Sundays.
    const dow = candidate.getDay();
    const dowMatch =
      matchesCronField(dowField, dow, 0, 7) || (dow === 0 && matchesCronField(dowField, 7, 0, 7));
    const dayMatch = bothDayFieldsRestricted
      ? domMatch || dowMatch // OR when both are constrained
      : domMatch && dowMatch; // AND when one is "*"

    if (dayMatch) return candidateTime;
  }
  return null;
}

export function matchesCronField(field: string, value: number, min: number, max: number): boolean {
  if (field === '*') return true;

  for (const part of field.split(',')) {
    if (part.includes('/')) {
      const [range, stepStr] = part.split('/');
      const step = parseInt(stepStr, 10);
      if (isNaN(step) || step <= 0) continue;
      let start = min;
      let end = max;
      if (range !== '*') {
        if (range.includes('-')) {
          const [lo, hi] = range.split('-').map(Number);
          if (isNaN(lo) || isNaN(hi)) continue;
          start = lo;
          end = hi;
        } else {
          start = parseInt(range, 10);
          if (isNaN(start)) continue;
        }
      }
      if (value >= start && value <= end && (value - start) % step === 0) return true;
    } else if (part.includes('-')) {
      const [lo, hi] = part.split('-').map(Number);
      if (!isNaN(lo) && !isNaN(hi) && value >= lo && value <= hi) return true;
    } else {
      if (parseInt(part, 10) === value) return true;
    }
  }
  return false;
}

export { MAX_AUTOMATIONS_PER_SESSION, MAX_CONSECUTIVE_FAILURES, DEFAULT_EXPIRY_DAYS };
