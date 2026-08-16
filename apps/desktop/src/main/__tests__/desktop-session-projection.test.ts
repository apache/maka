import assert from 'node:assert/strict';
import test from 'node:test';
import type { SessionEvent } from '@maka/core/events';
import type { SessionSummary } from '@maka/core/session';
import {
  projectDesktopAttachmentRefs,
  projectDesktopDailyReviewSummary,
  projectDesktopSessionEvent,
  projectDesktopSessionSummary,
  projectDesktopStoredMessage,
  projectDesktopTurnRecord,
  projectDesktopUsageStats,
} from '../../shared/desktop-session-projection.js';

test('keeps equal raw Session ids distinct across Runtime Hosts', () => {
  const raw = summary('same-session');
  const local = projectDesktopSessionSummary(
    {
      hostId: 'local-root',
      profileId: 'local',
      profileName: 'Local',
      profileKind: 'local',
    },
    raw,
  );
  const remote = projectDesktopSessionSummary(
    {
      hostId: 'remote-root',
      profileId: 'office',
      profileName: 'Office',
      profileKind: 'remote',
    },
    raw,
  );

  assert.notEqual(local.id, remote.id);
  assert.equal(local.profileKind, 'local');
  assert.equal(remote.profileName, 'Office');
});

test('projects typed linked Session ids without rewriting opaque tool data', () => {
  const host = { hostId: 'remote-root' };
  const linkedSessionId = JSON.stringify(['remote-root', 'child-session']);
  const subagent = projectDesktopSessionEvent(host, {
    type: 'tool_result_preview',
    id: 'event-1',
    turnId: 'turn-1',
    ts: 1,
    toolUseId: 'tool-1',
    isError: false,
    content: {
      kind: 'subagent',
      childSessionId: 'child-session',
      agentName: 'Worker',
      turnId: 'child-turn',
      status: 'running',
      permissionMode: 'ask',
    },
  });
  const opaque = projectDesktopSessionEvent(host, {
    type: 'tool_result',
    id: 'event-2',
    turnId: 'turn-1',
    ts: 2,
    toolUseId: 'tool-2',
    isError: false,
    content: { kind: 'json', value: { childSessionId: 'opaque-value' } },
  });

  assert.equal(
    (subagent as Extract<SessionEvent, { type: 'tool_result_preview' }>).content.childSessionId,
    linkedSessionId,
  );
  assert.deepEqual(
    (opaque as Extract<SessionEvent, { type: 'tool_result' }>).content,
    { kind: 'json', value: { childSessionId: 'opaque-value' } },
  );
  assert.equal(
    projectDesktopTurnRecord(host, {
      turnId: 'turn-1',
      status: 'completed',
      parentSessionId: 'child-session',
      partialOutputRetained: false,
    }).parentSessionId,
    linkedSessionId,
  );
});

test('projects Session ids at every Desktop data boundary', () => {
  const host = { hostId: 'remote-root' };
  const projectedId = JSON.stringify(['remote-root', 'session-1']);
  const [attachment] = projectDesktopAttachmentRefs(host, [{
    kind: 'image',
    name: 'image.png',
    mimeType: 'image/png',
    bytes: 1,
    ref: { kind: 'session_file', sessionId: 'session-1', relativePath: 'image.png' },
  }]);

  assert.equal(
    attachment?.ref.kind === 'session_file' ? attachment.ref.sessionId : undefined,
    projectedId,
  );
  const stored = projectDesktopStoredMessage(host, {
    type: 'turn_state',
    id: 'state-1',
    turnId: 'turn-1',
    ts: 1,
    status: 'completed',
    parentSessionId: 'session-1',
    partialOutputRetained: false,
  });
  assert.equal(stored.type === 'turn_state' ? stored.parentSessionId : undefined, projectedId);
  assert.equal(
    projectDesktopDailyReviewSummary(host, {
      day: { fromMs: 0, toMs: 1 },
      totals: {
        sessionCount: 1,
        requestCount: 0,
        totalTokens: 0,
        costUsd: 0,
        errorCount: 0,
      },
      sessions: [{ id: 'session-1', name: 'Session', lastMessageAt: 1 }],
      topTools: [],
      topModels: [],
    }).sessions[0]?.id,
    projectedId,
  );
  assert.equal(
    projectDesktopUsageStats(host, {
      summary: {
        totalRequests: 1,
        totalCostUsd: 0,
        totalTokens: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheTokens: 0,
        cacheMiss: 0,
        cacheRead: 0,
        cacheCreation: 0,
        reasoning: 0,
      },
      logs: [{
        id: 'log-1',
        ts: 1,
        kind: 'model',
        sessionId: 'session-1',
        turnId: 'turn-1',
        provider: 'openai',
        model: 'model',
        inputTokens: 0,
        outputTokens: 0,
        status: 'success',
      }],
      byProvider: [],
      byModel: [],
      byTool: [],
      pricing: [],
    }).logs[0]?.sessionId,
    projectedId,
  );
});

function summary(id: string): SessionSummary {
  return {
    id,
    name: id,
    isFlagged: false,
    isArchived: false,
    labels: [],
    hasUnread: false,
    status: 'active',
    backend: 'ai-sdk',
    llmConnectionSlug: 'default',
    connectionLocked: false,
    model: 'model',
    permissionMode: 'ask',
  };
}
