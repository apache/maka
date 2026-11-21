/**
 * 每账号运行报告(RunReport):结构化记录一次注册的全过程。
 * 写入 SQLite runs 表,并在 stdout 打印摘要。修复 demo 用 console.log 无法事后排查的问题。
 */
import type { Email, PhoneNumber } from '../types/brand.js';

export type RunMode = 'register' | 'resume' | 'phase8';
export type RunOutcome = 'success' | 'failed' | 'cancelled';

export interface TransitionRecord {
    readonly from: string;
    readonly to: string;
    readonly at: string;
    readonly note?: string;
}

export interface ErrorRecord {
    readonly phase: string;
    readonly message: string;
    readonly at: string;
}

export interface HealingRecord {
    readonly kind: string;
    readonly at: string;
    readonly note?: string;
}

export interface RunReport {
    readonly runId: string;
    readonly mode: RunMode;
    readonly startedAt: string;
    readonly finishedAt: string;
    readonly outcome: RunOutcome;
    readonly account?: {
        readonly phone?: PhoneNumber;
        readonly email?: Email;
        readonly fullName?: string;
        readonly birthDate?: string;
    };
    readonly sms?: { readonly provider: string; readonly activationId?: string | number; readonly costUsd?: number };
    readonly mail?: { readonly provider: string; readonly address?: Email };
    readonly oauth?: { readonly codeCaptured?: boolean; readonly tokenSavedTo?: readonly string[] };
    readonly phasesReached: readonly string[];
    readonly transitions: readonly TransitionRecord[];
    readonly errors: readonly ErrorRecord[];
    readonly healingActions: readonly HealingRecord[];
    readonly metrics: {
        readonly roundsSignup: number;
        readonly roundsOAuth: number;
        readonly smsPollAttempts: number;
        readonly mailPollAttempts: number;
    };
}

export class RunReportBuilder {
    private transitions: TransitionRecord[] = [];
    private errors: ErrorRecord[] = [];
    private healing: HealingRecord[] = [];
    private phasesReached: string[] = [];
    private roundsSignup = 0;
    private roundsOAuth = 0;
    private smsPollAttempts = 0;
    private mailPollAttempts = 0;

    constructor(
        private readonly runId: string,
        private readonly mode: RunMode,
        private readonly startedAt: string = new Date().toISOString(),
    ) {}

    addTransition(from: string, to: string, note?: string): void {
        this.transitions.push({ from, to, at: new Date().toISOString(), note });
    }
    addError(phase: string, message: string): void {
        this.errors.push({ phase, message, at: new Date().toISOString() });
    }
    addHealing(kind: string, note?: string): void {
        this.healing.push({ kind, at: new Date().toISOString(), note });
    }
    reachPhase(phase: string): void {
        if (!this.phasesReached.includes(phase)) this.phasesReached.push(phase);
    }
    incRoundsSignup(): void {
        this.roundsSignup++;
    }
    incRoundsOAuth(): void {
        this.roundsOAuth++;
    }
    incSmsPoll(): void {
        this.smsPollAttempts++;
    }
    incMailPoll(): void {
        this.mailPollAttempts++;
    }

    build(outcome: RunOutcome, extra: Partial<Omit<RunReport, 'runId' | 'mode' | 'startedAt' | 'outcome'>> = {}): RunReport {
        return {
            runId: this.runId,
            mode: this.mode,
            startedAt: this.startedAt,
            finishedAt: new Date().toISOString(),
            outcome,
            phasesReached: this.phasesReached,
            transitions: this.transitions,
            errors: this.errors,
            healingActions: this.healing,
            metrics: {
                roundsSignup: this.roundsSignup,
                roundsOAuth: this.roundsOAuth,
                smsPollAttempts: this.smsPollAttempts,
                mailPollAttempts: this.mailPollAttempts,
            },
            ...extra,
        };
    }
}
