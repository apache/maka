import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { deriveCapabilityAuditReport } from '@maka/core';
import { CapabilityAuditStrip, LocaleProvider } from '@maka/ui';

describe('capability audit visible system contract', () => {
  it('renders sources, skills, and automations status without widening skill permissions', () => {
    const report = deriveCapabilityAuditReport({
      now: 1_700_000_000_000,
      skills: [
        {
          id: 'writer',
          name: 'Writer',
          description: 'Drafts release notes.',
          declaredTools: ['Read', 'Write', 'Bash'],
        },
      ],
      planReminders: [
        {
          id: 'plan-1',
          title: '每日复盘',
          note: '',
          schedule: { kind: 'recurring', startAt: 1_700_000_000_000, recurrence: 'daily' },
          delivery: { channel: 'local' },
          status: 'scheduled',
          enabled: true,
          createdAt: 1_700_000_000_000,
          updatedAt: 1_700_000_000_000,
          nextRunAt: 1_700_003_600_000,
          lastRun: { id: 'run-1', at: 1_700_001_000_000, status: 'failed', message: 'failed' },
          runs: [],
          runCount: 1,
        },
      ],
    });

    // Designer audit P1-7: the strip reports by exception. With a failed
    // automation it renders ONE warning line; the retired metrics band
    // (能力审计 kicker, 声明工具 jargon, 来源/技能/自动化 dl) must not
    // come back — the page tabs already carry those counts.
    const markup = renderToStaticMarkup(createElement(LocaleProvider, {
      locale: 'zh',
      children: createElement(CapabilityAuditStrip, { report }),
    }));

    assert.match(markup, /aria-label="能力风险提示"/);
    assert.match(markup, /1 个自动化上次失败/);
    assert.doesNotMatch(markup, /能力审计/);
    assert.doesNotMatch(markup, /声明工具/);
    assert.doesNotMatch(markup, /<dl/);

    // Healthy report → nothing at all (no empty band eating first-screen).
    const healthyReport = deriveCapabilityAuditReport({
      now: 1_700_000_000_000,
      skills: [
        {
          id: 'writer',
          name: 'Writer',
          description: 'Drafts release notes.',
          declaredTools: ['Read'],
        },
      ],
      planReminders: [],
    });
    assert.equal(
      renderToStaticMarkup(createElement(LocaleProvider, {
        locale: 'zh',
        children: createElement(CapabilityAuditStrip, { report: healthyReport }),
      })),
      '',
      'healthy capability report must render nothing',
    );

    assert.equal(report.skills[0].permissionMode, 'ask');
    assert.notEqual(report.skills[0].permissionMode, 'execute');
  });
});
