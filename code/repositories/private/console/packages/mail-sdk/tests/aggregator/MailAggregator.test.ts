import { describe, it, expect } from 'vitest';
import { MailAggregator } from '../../src/aggregator/MailAggregator.js';
import { MockMailProvider, makeMockMessage } from './MockMailProvider.js';

describe('MailAggregator', () => {
    it('register / unregister / tags', () => {
        const agg = new MailAggregator();
        agg.register({ tag: 'a', provider: new MockMailProvider({ mailbox: 'a@x.com' }) });
        agg.register({ tag: 'b', provider: new MockMailProvider({ mailbox: 'b@x.com' }) });
        expect(agg.tags()).toEqual(['a', 'b']);
        agg.unregister('a');
        expect(agg.tags()).toEqual(['b']);
    });

    it('重复 tag 抛错', () => {
        const agg = new MailAggregator();
        agg.register({ tag: 'a', provider: new MockMailProvider({ mailbox: 'a@x.com' }) });
        expect(() => agg.register({ tag: 'a', provider: new MockMailProvider({ mailbox: 'c@x.com' }) })).toThrow();
    });

    it('listAcross:合并按 date 倒序 + 携带 tag', async () => {
        const agg = new MailAggregator();
        agg.register({
            tag: 'work',
            provider: new MockMailProvider({
                mailbox: 'w@x.com',
                messages: [makeMockMessage({ id: 'w1', date: '2024-01-02T00:00:00.000Z', subject: 'w1' })],
            }),
        });
        agg.register({
            tag: 'home',
            provider: new MockMailProvider({
                mailbox: 'h@x.com',
                messages: [
                    makeMockMessage({ id: 'h1', date: '2024-01-03T00:00:00.000Z', subject: 'h1' }),
                    makeMockMessage({ id: 'h2', date: '2024-01-01T00:00:00.000Z', subject: 'h2' }),
                ],
            }),
        });
        const result = await agg.listAcross({ limit: 10 });
        expect(result.messages.map((m) => m.message.id)).toEqual(['h1', 'w1', 'h2']);
        expect(result.messages[0]?.tag).toBe('home');
    });

    it('listAcross:单 provider 失败进 errors,不阻塞其他', async () => {
        const agg = new MailAggregator();
        const failing = new MockMailProvider({ mailbox: 'f@x.com' });
        failing.setFailure('listMessages', new Error('连接失败'));
        agg.register({ tag: 'fail', provider: failing });
        agg.register({
            tag: 'ok',
            provider: new MockMailProvider({
                mailbox: 'o@x.com',
                messages: [makeMockMessage({ id: 'o1', date: '2024-01-01T00:00:00.000Z' })],
            }),
        });
        const result = await agg.listAcross();
        expect(result.messages.map((m) => m.message.id)).toEqual(['o1']);
        expect(result.errors['fail']).toBe('连接失败');
        expect(result.errors['ok']).toBeUndefined();
    });

    it('searchAcross:跨 provider 合并 + 过滤', async () => {
        const agg = new MailAggregator();
        agg.register({
            tag: 'a',
            provider: new MockMailProvider({
                mailbox: 'a@x.com',
                messages: [makeMockMessage({ id: '1', date: '2024-01-02T00:00:00.000Z', subject: 'invoice 1' })],
            }),
        });
        agg.register({
            tag: 'b',
            provider: new MockMailProvider({
                mailbox: 'b@x.com',
                messages: [
                    makeMockMessage({ id: '2', date: '2024-01-03T00:00:00.000Z', subject: 'invoice 2' }),
                    makeMockMessage({ id: '3', date: '2024-01-01T00:00:00.000Z', subject: 'other' }),
                ],
            }),
        });
        const result = await agg.searchAcross({ subject: 'invoice' });
        expect(result.messages.map((m) => m.message.id)).toEqual(['2', '1']);
    });

    it('listAllFolders:每项携带 tag', async () => {
        const agg = new MailAggregator();
        agg.register({
            tag: 'a',
            provider: new MockMailProvider({
                mailbox: 'a@x.com',
                folders: [{ id: 'INBOX', name: 'INBOX', displayName: 'INBOX', specialRole: 'inbox', selectable: true }],
            }),
        });
        const folders = await agg.listAllFolders();
        expect(folders[0]?.tag).toBe('a');
        expect(folders[0]?.specialRole).toBe('inbox');
    });

    it('disconnectAll:断开所有 provider 并清空', async () => {
        const agg = new MailAggregator();
        const p = new MockMailProvider({ mailbox: 'a@x.com' });
        agg.register({ tag: 'a', provider: p });
        await p.connect();
        expect(p.isConnected()).toBe(true);
        await agg.disconnectAll();
        expect(p.isConnected()).toBe(false);
        expect(agg.tags()).toEqual([]);
    });

    it('nextTokensByTag:回传各 provider 分页 token', async () => {
        const agg = new MailAggregator();
        agg.register({
            tag: 'a',
            provider: new MockMailProvider({
                mailbox: 'a@x.com',
                messages: [makeMockMessage({ id: '1', date: '2024-01-01T00:00:00.000Z' })],
            }),
        });
        const result = await agg.listAcross();
        expect(result.nextTokensByTag['a']).toBeUndefined(); // Mock 无分页
    });
});
