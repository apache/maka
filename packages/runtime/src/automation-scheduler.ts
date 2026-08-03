/**
 * Automation scheduler — manages a tick loop that fires active automations.
 *
 * Fixes applied from adversarial review:
 * - canFire errors are caught per-automation (don't abort the whole tick)
 * - injectTurn/createFreshRun failures properly mark the automation as failed
 * - A busy session defers the fire inside a ~45min retry window (equivalent to
 *   the old wakeup-scheduler's 5s→5min exponential backoff budget); only when
 *   the window is exhausted does skipFire() advance/settle the schedule
 * - Defer bookkeeping is pruned when automations disappear
 * - dispose() sets flag checked in async paths to prevent post-dispose execution
 * - Uses deps.now() consistently (injectable for testing)
 */

import type { AutomationDefinition, AutomationManager } from './automation-state.js';

/** Outcome of a dispatched fire, decided only after the run's stream finishes. */
export interface AutomationFireResult {
  /** The run/turn id the fire produced (for attribution / lastRunId). */
  runId?: string;
  /** Whether the run completed successfully (no error / abort). */
  ok: boolean;
  /** Failure reason when !ok. */
  error?: string;
}

export interface AutomationSchedulerDeps {
  automationManager: AutomationManager;
  /**
   * Whether this automation may fire right now. Receives the whole automation
   * so the host can gate kind-appropriately: a heartbeat injects into its own
   * session (gate on that session's existence/idleness), while a cron spawns a
   * FRESH session (its creator session is irrelevant — gate only on global
   * concerns like privacy mode). Global gates (e.g. incognito) apply to both.
   */
  canFire: (automation: AutomationDefinition) => Promise<boolean>;
  /**
   * Inject a turn into the automation's own session (heartbeat kind).
   * Resolves with the run outcome AFTER the turn's stream finishes.
   */
  injectTurn: (
    sessionId: string,
    prompt: string,
    automationId: string,
  ) => Promise<AutomationFireResult>;
  /**
   * Spawn a fresh session and run the prompt there (cron kind).
   * Resolves with the run outcome AFTER the run's stream finishes.
   * When absent, the host does not support cron and cron fires fail.
   */
  createFreshRun?: (prompt: string, automationId: string) => Promise<AutomationFireResult>;
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (timer: unknown) => void;
  now?: () => number;
  onStateChange?: () => void;
}

const FIRE_CHECK_INTERVAL_MS = 5000; // 5s tick (must be < minimum interval of 10s)

/**
 * Defer window for a fire that lands on a busy session.
 *
 * Review fix (#639 semantics restored): the whole point of a heartbeat is to
 * fire after long-running work — agent turns routinely run for many minutes,
 * so a ~120s retry budget silently dropped (and for `once` terminally expired)
 * any fire that landed mid-turn. The old wakeup-scheduler retried with
 * exponential backoff, 5s doubling to a 5min cap, waiting ~45 minutes in
 * total before giving up. This
 * scheduler is tick-driven (a fixed 5s cadence), so the equivalent retry
 * budget is expressed as a wall-clock window: keep deferring for
 * DEFER_WINDOW_MS from the first deferred attempt, and only then skip the
 * fire (skipFire advances a recurring schedule; a `once` automation expires
 * ONLY when this window is exhausted — never on a transient busy blip).
 */
const DEFER_WINDOW_MS = 45 * 60 * 1000;

/** Per-automation defer bookkeeping for the current pending fire. */
interface DeferState {
  firstDeferredAt: number;
  count: number;
}

export class AutomationScheduler {
  private tickTimer: unknown = null;
  private disposed = false;
  private deferStates = new Map<string, DeferState>();
  /** Automation ids whose fire is currently executing (prevents concurrent re-fire). */
  private inFlight = new Set<string>();
  private readonly now: () => number;

  constructor(private readonly deps: AutomationSchedulerDeps) {
    this.now = deps.now ?? (() => Date.now());
  }

  start(): void {
    if (this.disposed) return;
    this.scheduleTick();
  }

  stop(): void {
    if (this.tickTimer !== null) {
      this.deps.clearTimeout(this.tickTimer);
      this.tickTimer = null;
    }
  }

  dispose(): void {
    this.disposed = true;
    this.stop();
    this.deferStates.clear();
    this.inFlight.clear();
  }

  private scheduleTick(): void {
    if (this.disposed) return;
    this.tickTimer = this.deps.setTimeout(() => {
      if (this.disposed) return;
      this.checkAndFire()
        .catch(() => {})
        .finally(() => {
          if (!this.disposed) this.scheduleTick();
        });
    }, FIRE_CHECK_INTERVAL_MS);
  }

  private async checkAndFire(): Promise<void> {
    const now = this.now();
    const active = this.deps.automationManager.listActive();

    // Prune defer bookkeeping for automations that no longer exist.
    const activeIds = new Set(active.map((a) => a.id));
    for (const id of this.deferStates.keys()) {
      if (!activeIds.has(id)) this.deferStates.delete(id);
    }

    // Eager expiry sweep: expire automations whose expiresAt has passed,
    // regardless of nextFireAt. Prevents zombie-active entries.
    let sweptAny = false;
    for (const automation of active) {
      // Same invariant as attemptFire: a host without a cron executor must not
      // mutate/persist crons at all — the durable store may be shared with a
      // host that CAN run them, and this host's in-memory copy may be stale
      // (no reload after startup), so expiring a cron here could clobber the
      // owning host's edits on disk. Leave crons entirely to that host.
      if (automation.kind === 'cron' && !this.deps.createFreshRun) continue;
      if (automation.expiresAt && now >= automation.expiresAt) {
        if (this.deps.automationManager.sweepExpired(automation.id)) sweptAny = true;
      }
    }
    if (sweptAny) this.deps.onStateChange?.();

    // Re-fetch active list after expiry sweep.
    const stillActive = this.deps.automationManager.listActive();
    for (const automation of stillActive) {
      if (this.disposed) return;
      if (!automation.nextFireAt || automation.nextFireAt > now) continue;
      await this.attemptFire(automation);
    }
  }

  private async attemptFire(automation: AutomationDefinition): Promise<void> {
    if (this.disposed) return;

    // A host without a cron executor cannot run cron automations. Leave them
    // COMPLETELY untouched — do not fail, pause, or advance them, and emit no
    // state change. The durable store may be shared with a host that CAN run
    // them (e.g. the desktop shares its workspace with the `maka` CLI), so
    // marking a cron failed/paused here would corrupt that shared durable state
    // (a heartbeat-only CLI would otherwise pause the desktop's crons on disk).
    if (automation.kind === 'cron' && !this.deps.createFreshRun) return;

    // In-flight guard: a fire whose run is still executing must not be started
    // again. canFire protects heartbeat (its run occupies the automation's own
    // session), but NOT cron (createFreshRun spawns a separate session, leaving
    // the creator session idle), so a cron whose run outlasts its cadence would
    // otherwise re-fire every tick — spawning duplicate sessions, blowing past
    // maxFires, and committing outcomes out of order. This guard closes that
    // window for every kind, independent of canFire.
    if (this.inFlight.has(automation.id)) return;

    let canFire: boolean;
    try {
      canFire = await this.deps.canFire(automation);
    } catch {
      // canFire failure: skip this automation this tick, don't crash the loop.
      return;
    }

    if (this.disposed) return;
    // Re-check the guard after the async canFire (another tick may have started).
    if (this.inFlight.has(automation.id)) return;

    if (!canFire) {
      const now = this.now();
      // Observability: surface deferred attempts in the model-facing list
      // (mirrors the old CronList's fire_attempts/deferred_fires).
      this.deps.automationManager.recordDeferredFire(automation.id);
      const state = this.deferStates.get(automation.id);
      if (!state) {
        // First deferral for this pending fire — open the retry window.
        this.deferStates.set(automation.id, { firstDeferredAt: now, count: 1 });
        return;
      }
      if (now - state.firstDeferredAt >= DEFER_WINDOW_MS) {
        // Retry window exhausted — skip this fire entirely: a recurring
        // schedule advances to its next slot; a `once` automation settles
        // terminally (its window has genuinely passed, not a transient blip).
        this.deferStates.delete(automation.id);
        this.deps.automationManager.skipFire(automation.id);
        this.deps.onStateChange?.();
        return;
      }
      state.count++;
      return;
    }

    this.deferStates.delete(automation.id);

    const started = this.deps.automationManager.attemptStarted(automation.id);
    if (!started) {
      this.deps.onStateChange?.();
      return;
    }
    // Persist the started state (fireCount/nextFireAt advanced) immediately.
    this.deps.onStateChange?.();

    const id = automation.id;
    this.inFlight.add(id);
    // Dispatch WITHOUT awaiting the tick — the run resolves its outcome later.
    // The outcome (success/failure) is committed only after the stream finishes,
    // so a failed or aborted fire is never recorded as a success.
    const dispatch =
      automation.kind === 'heartbeat'
        ? this.deps.injectTurn(
            automation.sessionId,
            `[Automation: ${automation.name}]\n\n${automation.prompt}`,
            id,
          )
        : this.deps.createFreshRun!(automation.prompt, id);

    void dispatch
      .then((result) => {
        this.inFlight.delete(id);
        if (this.disposed) return;
        if (result.ok) {
          this.deps.automationManager.attemptSucceeded(id, result.runId);
        } else {
          this.deps.automationManager.attemptFailed(id, result.error ?? 'Automation run failed');
        }
        this.deps.onStateChange?.();
      })
      .catch((err) => {
        this.inFlight.delete(id);
        if (this.disposed) return;
        const message = err instanceof Error ? err.message : String(err);
        this.deps.automationManager.attemptFailed(id, message);
        this.deps.onStateChange?.();
      });
  }
}

export { FIRE_CHECK_INTERVAL_MS, DEFER_WINDOW_MS };
