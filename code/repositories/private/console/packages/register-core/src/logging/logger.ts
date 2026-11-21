/**
 * 结构化日志(pino):JSON Lines 输出到 stdout + 归档到 data/logs/app-YYYY-MM-DD.log。
 * 每 run 用 child logger 注入 runId/accountId 等上下文。敏感字段提供 mask 工具。
 */
import fs from 'node:fs';
import path from 'node:path';
import pino, { type Logger } from 'pino';

export interface LoggerOptions {
    level?: string;
    logDir?: string;
}

let rootLogger: Logger | null = null;

export function initRootLogger(opts: LoggerOptions = {}): Logger {
    if (rootLogger) return rootLogger;
    const level = (opts.level ?? 'info') as pino.Level;
    const dest = opts.logDir ? path.resolve(opts.logDir) : null;
    if (dest) fs.mkdirSync(dest, { recursive: true });

    const streams: pino.StreamEntry[] = [{ level, stream: process.stdout }];
    if (dest) {
        streams.push({
            level,
            stream: fs.createWriteStream(path.join(dest, `app-${todayStr()}.log`), { flags: 'a' }),
        });
    }
    rootLogger = pino({ level }, pino.multistream(streams));
    return rootLogger;
}

export function getLogger(): Logger {
    return rootLogger ?? initRootLogger();
}

/** 创建带上下文绑定的 child logger(注入 runId/accountId 等)。 */
export function childLogger(bindings: Record<string, unknown>): Logger {
    return getLogger().child(bindings);
}

export function resetLoggerForTest(): void {
    rootLogger = null;
}

// ---- 脱敏工具(日志/报告打印敏感字段前调用) ----

export function maskSecret(value: string | null | undefined, head = 2, tail = 2): string {
    if (!value) return '';
    const s = String(value);
    if (s.length <= head + tail) return '*'.repeat(s.length);
    return `${s.slice(0, head)}${'*'.repeat(Math.min(8, s.length - head - tail))}${s.slice(-tail)}`;
}

export function maskPhone(phone: string | null | undefined): string {
    if (!phone) return '';
    return phone.length > 5 ? `${phone.slice(0, 3)}****${phone.slice(-2)}` : '*'.repeat(phone.length);
}

export function maskEmail(email: string | null | undefined): string {
    if (!email) return '';
    const at = email.indexOf('@');
    if (at <= 1) return email;
    return `${email[0]}***${email.slice(at)}`;
}

function todayStr(): string {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
