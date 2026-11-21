/**
 * 持久化集成测试:用真实 better-sqlite3(临时文件 DB)验证事务化读写。
 * 证明 SQLite 层 + Repository + 迁移真的工作,替代 demo 的非原子 JSON 读写。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openDatabase } from '../../src/persistence/db.js';
import { AccountRepository } from '../../src/persistence/AccountRepository.js';
import { UsernameRepository } from '../../src/persistence/UsernameRepository.js';
import { RunRepository } from '../../src/persistence/RunRepository.js';
import { TokenRepository } from '../../src/persistence/TokenRepository.js';

let dbPath: string;

beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `reg-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
});

afterEach(() => {
    try {
        fs.unlinkSync(dbPath);
    } catch {
        /* ignore */
    }
});

describe('持久化集成(真实 SQLite)', () => {
    it('accounts:CRUD + 状态更新 + 事务化 markOauthDone', () => {
        const db = openDatabase(dbPath);
        const repo = new AccountRepository(db);

        const id = repo.insert({ phone: '+447111', password: 'secret', fullName: 'A B', birthDate: '2000-01-01' });
        expect(id).toBeGreaterThan(0);

        const found = repo.findByPhone('+447111');
        expect(found?.status).toBe('registered');
        expect(found?.fullName).toBe('A B');

        repo.markOauthDone('+447111');
        expect(repo.findByPhone('+447111')?.status).toBe('oauth_done');
        expect(repo.countByStatus('oauth_done')).toBe(1);

        db.close();
    });

    it('username + tokens:邮箱会话与 token 关联写入', () => {
        const db = openDatabase(dbPath);
        const accounts = new AccountRepository(db);
        const usernames = new UsernameRepository(db);
        const tokens = new TokenRepository(db);

        const accountId = accounts.insert({ phone: '+447222', password: 'p', fullName: 'C D', birthDate: '1999-05-05' });
        const usernameId = usernames.insert({
            accountId,
            email: 'test@example.local',
            mailProvider: 'legacy',
            mailSession: { provider: 'legacy', address: 'test@example.local' as never, jwt: 'jwt-abc' },
        });
        tokens.insert({
            usernameId,
            email: 'test@example.local',
            accountId: 'oai-acc-1',
            accessToken: 'access-tok',
            refreshToken: 'refresh-tok',
            idToken: 'id-tok',
            expiredAt: '2026-12-31T00:00:00+08:00',
            savedFilePaths: ['tokens/codex-test-free.json'],
        });

        const row = usernames.findByEmail('test@example.local');
        expect(row?.mailSession?.jwt).toBe('jwt-abc');

        const tok = tokens.findByEmail('test@example.local');
        expect(tok?.accessToken).toBe('access-tok');
        expect(tok?.savedFilePaths).toContain('tokens/codex-test-free.json');

        db.close();
    });

    it('runs:运行报告记录与查询', () => {
        const db = openDatabase(dbPath);
        const runs = new RunRepository(db);

        runs.insertRunning('run-xyz', 'register', '+447333');
        runs.finish('run-xyz', 'success', { phasesReached: ['phase1', 'phase2', 'phase3'] });

        const row = runs.findByRunId('run-xyz');
        expect(row?.status).toBe('success');
        expect(row?.phasesReached).toEqual(['phase1', 'phase2', 'phase3']);
        expect(row?.accountPhone).toBe('+447333');

        db.close();
    });
});
