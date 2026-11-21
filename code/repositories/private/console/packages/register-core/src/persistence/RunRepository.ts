/** runs 表仓储:每次注册的结构化运行报告(RunReport),供事后排查与统计。 */
import type { DBType } from './db.js';
import type { RunReport, RunMode } from '../logging/runReport.js';

export type RunStatus = 'running' | 'success' | 'failed' | 'cancelled';

export interface RunRow {
    readonly id: number;
    readonly runId: string;
    readonly accountPhone: string | null;
    readonly mode: RunMode;
    readonly startedAt: string;
    readonly finishedAt: string | null;
    readonly status: RunStatus;
    readonly errorMessage: string | null;
    readonly phasesReached: readonly string[];
    readonly report: RunReport | null;
}

interface RunRowDb {
    id: number;
    run_id: string;
    account_phone: string | null;
    mode: string;
    started_at: string;
    finished_at: string | null;
    status: string;
    error_message: string | null;
    phases_reached: string | null;
    report_json: string | null;
}

function toRow(r: RunRowDb): RunRow {
    let phases: string[] = [];
    try {
        phases = r.phases_reached ? (JSON.parse(r.phases_reached) as string[]) : [];
    } catch {
        phases = [];
    }
    let report: RunReport | null = null;
    try {
        report = r.report_json ? (JSON.parse(r.report_json) as RunReport) : null;
    } catch {
        report = null;
    }
    return {
        id: r.id,
        runId: r.run_id,
        accountPhone: r.account_phone,
        mode: r.mode as RunMode,
        startedAt: r.started_at,
        finishedAt: r.finished_at,
        status: r.status as RunStatus,
        errorMessage: r.error_message,
        phasesReached: phases,
        report,
    };
}

export class RunRepository {
    constructor(private readonly db: DBType) {}

    insertRunning(runId: string, mode: RunMode, accountPhone: string | null): void {
        this.db
            .prepare(
                `INSERT INTO runs (run_id, account_phone, mode, started_at, status) VALUES (?, ?, ?, ?, 'running')`,
            )
            .run(runId, accountPhone, mode, new Date().toISOString());
    }

    finish(
        runId: string,
        status: RunStatus,
        opts: { errorMessage?: string; report?: RunReport; phasesReached?: readonly string[] } = {},
    ): void {
        this.db
            .prepare(
                `UPDATE runs SET status = ?, finished_at = ?, error_message = ?, phases_reached = ?, report_json = ? WHERE run_id = ?`,
            )
            .run(
                status,
                new Date().toISOString(),
                opts.errorMessage ?? null,
                opts.phasesReached ? JSON.stringify(opts.phasesReached) : null,
                opts.report ? JSON.stringify(opts.report) : null,
                runId,
            );
    }

    findByRunId(runId: string): RunRow | null {
        const row = this.db.prepare(`SELECT * FROM runs WHERE run_id = ?`).get(runId) as unknown as RunRowDb | undefined;
        return row ? toRow(row) : null;
    }

    recent(limit = 20): RunRow[] {
        const rows = this.db.prepare(`SELECT * FROM runs ORDER BY id DESC LIMIT ?`).all(limit) as unknown as RunRowDb[];
        return rows.map(toRow);
    }
}
