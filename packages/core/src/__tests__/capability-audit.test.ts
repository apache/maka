import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  SCHEDULED_TASK_LAST_RUN_STATUSES,
  CAPABILITY_AUDIT_PERMISSION_MODES,
  LOCAL_SKILL_SOURCE_SLUG,
  SOURCE_AUTH_TYPES,
  SOURCE_RECORD_STATUSES,
  SOURCE_RECORD_TYPES,
  deriveCapabilityAuditReport,
  type CapabilityAuditSkillInput,
} from '../capability-audit.js';
import type { ScheduledTask } from '../scheduled-task.js';

describe('capability audit contract', () => {
  it('locks the visible source and ScheduledTask enums', () => {
    assert.deepEqual(SOURCE_RECORD_TYPES, ['mcp', 'api', 'local']);
    assert.deepEqual(SOURCE_AUTH_TYPES, ['oauth', 'bearer', 'none']);
    assert.deepEqual(SOURCE_RECORD_STATUSES, ['ready', 'needs_auth', 'error', 'disabled']);
    assert.deepEqual(CAPABILITY_AUDIT_PERMISSION_MODES, ['explore', 'ask', 'execute']);
    assert.deepEqual(SCHEDULED_TASK_LAST_RUN_STATUSES, ['ok', 'error', 'skipped']);
  });

  it('synthesizes a local skills source and keeps skill permission mode read-first', () => {
    const skills: CapabilityAuditSkillInput[] = [
      {
        id: 'research',
        name: 'Research',
        description: 'Drafts research notes.',
        declaredTools: ['Read', 'Bash', 'Write'],
      },
      {
        id: 'notes',
        name: 'Notes',
        description: '',
      },
    ];

    const report = deriveCapabilityAuditReport({ now: 1_700_000_000_000, skills });

    assert.equal(report.checkedAt, 1_700_000_000_000);
    assert.equal(report.sources.length, 1);
    assert.equal(report.sources[0].slug, LOCAL_SKILL_SOURCE_SLUG);
    assert.equal(report.sources[0].type, 'local');
    assert.equal(report.sources[0].status, 'ready');
    assert.deepEqual(report.sources[0].scopeSummary, ['2 个本地 Skill', '3 类声明工具']);
    assert.equal(report.summary.sourceCount, 1);
    assert.equal(report.summary.readySourceCount, 1);
    assert.equal(report.summary.skillCount, 2);
    assert.equal(report.summary.enabledSkillCount, 2);
    assert.equal(report.summary.skillsWithDeclaredTools, 1);
    assert.equal(report.summary.declaredToolKindCount, 3);
    assert.equal(report.skills[0].sourceSlug, LOCAL_SKILL_SOURCE_SLUG);
    assert.equal(report.skills[0].permissionMode, 'ask');
    assert.notEqual(report.skills[0].permissionMode, 'execute');
    assert.equal(report.skills[1].permissionMode, 'explore');
  });

  it('maps scheduled tasks into audit records without losing run state', () => {
    const tasks: ScheduledTask[] = [
      {
        id: 'scheduled-task-1',
        title: '每日复盘',
        intent: { kind: 'text', body: '' },
        schedule: { kind: 'calendar', anchorAt: 1_700_000_000_000, recurrence: 'daily' },
        effect: { kind: 'notify', channel: 'local' },
        status: 'active',
        createdAt: 1_700_000_000_000,
        updatedAt: 1_700_000_000_000,
        nextFireAt: 1_700_003_600_000,
        lastFireAt: 1_700_001_000_000,
        runs: [{ id: 'run-1', at: 1_700_001_000_000, outcome: 'ok', message: 'ok' }],
        fireCount: 1,
        maxFires: null,
        expiresAt: null,
        createdBy: { kind: 'user' },
        lastError: null,
      },
      {
        id: 'scheduled-task-2',
        title: '周会提醒',
        intent: { kind: 'text', body: '' },
        schedule: { kind: 'once', runAt: 1_700_000_100_000 },
        effect: { kind: 'notify', channel: 'local' },
        status: 'paused',
        createdAt: 1_700_000_000_000,
        updatedAt: 1_700_000_000_000,
        nextFireAt: null,
        lastFireAt: 1_700_001_500_000,
        runs: [{ id: 'run-2', at: 1_700_001_500_000, outcome: 'blocked', message: 'skip' }],
        fireCount: 0,
        maxFires: null,
        expiresAt: null,
        createdBy: { kind: 'user' },
        lastError: 'skip',
      },
      {
        id: 'scheduled-task-3',
        title: '月末归档',
        intent: { kind: 'text', body: '' },
        schedule: { kind: 'once', runAt: 1_700_000_200_000 },
        effect: { kind: 'notify', channel: 'local' },
        status: 'completed',
        createdAt: 1_700_000_000_000,
        updatedAt: 1_700_000_000_000,
        nextFireAt: null,
        lastFireAt: 1_700_001_900_000,
        runs: [{ id: 'run-3', at: 1_700_001_900_000, outcome: 'failed', message: 'fail' }],
        fireCount: 0,
        maxFires: null,
        expiresAt: null,
        createdBy: { kind: 'user' },
        lastError: 'fail',
      },
    ];

    const report = deriveCapabilityAuditReport({ scheduledTasks: tasks });

    assert.equal(report.scheduledTasks.length, 3);
    assert.equal(report.scheduledTasks[0].permissionMode, 'execute');
    assert.equal(report.scheduledTasks[0].lastRunStatus, 'ok');
    assert.equal(report.scheduledTasks[1].permissionMode, 'ask');
    assert.equal(report.scheduledTasks[1].lastRunStatus, 'skipped');
    assert.equal(report.scheduledTasks[2].permissionMode, 'explore');
    assert.equal(report.scheduledTasks[2].lastRunStatus, 'error');
    assert.equal(report.summary.scheduledTaskCount, 3);
    assert.equal(report.summary.enabledScheduledTaskCount, 1);
    assert.equal(report.summary.executableScheduledTaskCount, 1);
    assert.equal(report.summary.failedScheduledTaskCount, 1);
    assert.equal(report.summary.skippedScheduledTaskCount, 1);
  });

  it('keeps explicit remote sources visible without forcing a local duplicate', () => {
    const report = deriveCapabilityAuditReport({
      sources: [
        {
          slug: 'mcp-github',
          name: 'GitHub MCP',
          type: 'mcp',
          enabled: true,
          authType: 'oauth',
          scopeSummary: ['issues', 'pull requests'],
          status: 'ready',
          lastTestAt: 1_700_000_000_000,
        },
      ],
      skills: [
        {
          id: 'github-review',
          name: 'GitHub Review',
          description: 'Reviews PRs.',
          declaredTools: ['Read'],
          sourceSlug: 'mcp-github',
        },
      ],
    });

    assert.equal(report.sources.length, 1);
    assert.equal(report.sources[0].slug, 'mcp-github');
    assert.equal(report.skills[0].sourceSlug, 'mcp-github');
  });
});
