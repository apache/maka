import { strict as assert } from 'node:assert';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { readMainProcessCombinedSource } from './main-process-contract-source-helpers.js';

const REPO_ROOT = resolve(import.meta.dirname, '../../../../..');

async function readRepo(path: string): Promise<string> {
  if (path === 'apps/desktop/src/main/main.ts') return readMainProcessCombinedSource();
  const { readFile } = await import('node:fs/promises');
  return readFile(resolve(REPO_ROOT, path), 'utf8');
}

describe('Bot incoming idempotency contract (PR-BOT-INCOMING-IDEMPOTENCY-0)', () => {
  it('dedupes platform source message ids before ack/session/send side effects', async () => {
    const main = await readRepo('apps/desktop/src/main/main.ts');
    const handler = main.match(/async function handleBotIncomingMessage\([^)]*\): Promise<void> \{[\s\S]*?const text = message\.text\.trim\(\);/);

    assert.ok(handler, 'handleBotIncomingMessage block must exist');
    assert.match(handler![0], /if \(rememberBotSourceEvent\(message\)\) return;/);
    assert.ok(
      handler![0].indexOf('rememberBotSourceEvent(message)') < handler![0].indexOf('message.text.trim()'),
      'dedupe must run before non-text ack or session/send side effects',
    );
  });

  it('bounds the in-memory dedupe set and keys it through the core helper', async () => {
    const main = await readRepo('apps/desktop/src/main/main.ts');

    assert.match(main, /botSourceEventKey\(message\)/, 'main must use the shared core source-event key helper');
    assert.match(main, /const BOT_RECENT_SOURCE_EVENT_LIMIT = 1_000;/, 'dedupe set must stay bounded');
    assert.match(main, /while \(botRecentSourceEventKeys\.size > BOT_RECENT_SOURCE_EVENT_LIMIT\)/, 'dedupe set must evict old entries');
  });

  it('expires source-event dedupe entries by TTL before checking duplicates', async () => {
    const main = await readRepo('apps/desktop/src/main/main.ts');
    const remember = main.match(/function rememberBotSourceEvent\([^)]*\): boolean \{[\s\S]*?\n\}/);
    const prune = main.match(/function pruneExpiredBotSourceEvents\([^)]*\): void \{[\s\S]*?\n\}/);

    assert.ok(remember, 'rememberBotSourceEvent must exist');
    assert.ok(prune, 'pruneExpiredBotSourceEvents must exist');
    assert.match(main, /const BOT_RECENT_SOURCE_EVENT_TTL_MS = 60 \* 60 \* 1_000;/);
    assert.ok(
      remember![0].indexOf('pruneExpiredBotSourceEvents(now)') < remember![0].indexOf('botRecentSourceEventKeys.has(key)'),
      'expired dedupe entries must be pruned before duplicate lookup',
    );
    assert.match(
      prune![0],
      /if \(now - seenAt <= BOT_RECENT_SOURCE_EVENT_TTL_MS\) break;[\s\S]*botRecentSourceEventKeys\.delete\(key\)/,
      'dedupe TTL cleanup should delete expired oldest entries and keep the hard cap as secondary protection',
    );
  });

  it('rate-limits and session-caps bot turns before create/send side effects', async () => {
    const main = await readRepo('apps/desktop/src/main/main.ts');
    const processBlock = main.match(/async function processBotIncomingMessage\([^)]*\): Promise<void> \{[\s\S]*?\r?\n\s*\}\r?\n\r?\n\s*async function collectBotReply/);

    assert.ok(processBlock, 'processBotIncomingMessage block must exist');
    assert.match(main, /const BOT_CONVERSATION_SESSION_LIMIT = 500;/);
    assert.match(main, /const BOT_CONVERSATION_RATE_BURST = 8;/);
    assert.match(main, /const BOT_CONVERSATION_RATE_REFILL_MS = 5_000;/);
    assert.match(main, /const BOT_CONVERSATION_RATE_BUCKET_TTL_MS = 60 \* 60 \* 1_000;/);
    assert.match(main, /const BOT_CONVERSATION_RATE_BUCKET_LIMIT = 1_000;/);
    const consumeToken = main.match(/function consumeBotConversationToken\([^]*?\r?\n\s*\}\r?\n\r?\n\s*async function sendTransientBotNotice/);
    const pruneBuckets = main.match(/function pruneExpiredBotConversationRateBuckets\([^)]*\): void \{[\s\S]*?\r?\n\}/);
    assert.ok(consumeToken, 'consumeBotConversationToken helper must exist');
    assert.ok(pruneBuckets, 'rate bucket TTL pruning helper must exist');
    assert.match(consumeToken![0], /BOT_CONVERSATION_RATE_BURST/);
    assert.match(consumeToken![0], /BOT_CONVERSATION_RATE_REFILL_MS/);
    assert.match(consumeToken![0], /pruneExpiredBotConversationRateBuckets\(now\)/);
    assert.match(consumeToken![0], /bucket\.tokens -= 1/);
    assert.match(consumeToken![0], /while \(botConversationRateBuckets\.size > BOT_CONVERSATION_RATE_BUCKET_LIMIT\)/);
    assert.match(
      pruneBuckets![0],
      /now - bucket\.updatedAt > BOT_CONVERSATION_RATE_BUCKET_TTL_MS[\s\S]*botConversationRateBuckets\.delete\(key\)/,
      'stale rate buckets must be pruned independently of the session cap',
    );
    assert.match(main, /async function sendTransientBotNotice[\s\S]*ephemeralTtlMs: ttlMs/);

    const block = processBlock![0];
    const newSessionBranch = block.match(/if \(!sessionId\) \{[\s\S]*?const ready = await (?:deps\.)?getReadyConnection/);
    assert.ok(newSessionBranch, 'new bot conversation branch must exist');
    assert.ok(
      block.indexOf('consumeBotConversationToken(conversationKey)') < block.indexOf('deps.createSession'),
      'rate limit must run before creating a bot session',
    );
    assert.ok(
      block.indexOf('consumeBotConversationToken(conversationKey)') < block.indexOf('runtime.sendMessage'),
      'rate limit must run before runtime.sendMessage',
    );
    assert.ok(
      block.indexOf('botConversationSessions.size >= BOT_CONVERSATION_SESSION_LIMIT') < block.indexOf('deps.createSession'),
      'new bot binding cap must run before creating the 501st session',
    );
    assert.ok(
      newSessionBranch![0].indexOf('botConversationSessions.size >= BOT_CONVERSATION_SESSION_LIMIT')
        < newSessionBranch![0].indexOf('consumeBotConversationToken(conversationKey)'),
      'new conversations rejected by a full binding cap must not allocate rate buckets',
    );
    assert.match(
      block,
      /if \(!consumeBotConversationToken\(conversationKey\)\) \{[\s\S]*sendTransientBotNotice[\s\S]*return;/,
      'rate-limited turns must send at most a transient notice and return',
    );
    assert.match(
      block,
      /if \(botConversationSessions\.size >= BOT_CONVERSATION_SESSION_LIMIT\) \{[\s\S]*sendTransientBotNotice[\s\S]*return;/,
      'session-cap rejections must send at most a transient notice and return',
    );
  });

  it('forces existing bot-bound sessions back to explore before send or refuses the turn', async () => {
    const main = await readRepo('apps/desktop/src/main/main.ts');
    const processBlock = main.match(/async function processBotIncomingMessage\([^)]*\): Promise<void> \{[\s\S]*?\r?\n\s*\}\r?\n\r?\n\s*async function collectBotReply/);
    const guard = main.match(/async function ensureBotSessionExploreMode\([^)]*\): Promise<boolean> \{[\s\S]*?\n\}/);

    assert.ok(processBlock, 'processBotIncomingMessage block must exist');
    assert.ok(guard, 'ensureBotSessionExploreMode guard must exist');
    const block = processBlock![0];
    assert.ok(
      block.indexOf('ensureBotSessionExploreMode(sessionId, message, SYSTEM_NOTICE_TTL_MS)') < block.lastIndexOf('ensureSessionCanSend(sessionId)'),
      'existing bot sessions must be permission-checked before generic send readiness',
    );
    assert.ok(
      block.indexOf('ensureBotSessionExploreMode(sessionId, message, SYSTEM_NOTICE_TTL_MS)') < block.indexOf('runtime.sendMessage'),
      'existing bot sessions must be forced/refused before runtime.sendMessage',
    );
    assert.match(
      guard![0],
      /await (?:runtime|deps\.runtime)\.setPermissionMode\(sessionId, 'explore'\);[\s\S]*return true;/,
    );
    assert.doesNotMatch(
      guard![0],
      /updateSession\(sessionId, \{ permissionMode: 'explore' \}\)/,
      'bot read-only enforcement must update the authoritative boundary, not only its header projection',
    );
    assert.match(guard![0], /catch \{[\s\S]*sendTransientBotNotice[\s\S]*return false;/);
  });
});
