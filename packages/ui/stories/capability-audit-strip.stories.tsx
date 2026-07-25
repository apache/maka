import type { Meta, StoryObj } from '@storybook/react-vite';
import type { CapabilityAuditReport } from '@maka/core';
import { CapabilityAuditStrip } from '../src/capability-audit-strip.js';

// FIDELITY CONVENTION (#1433) — every story in this file must map to an app
// state a real user can reach, with that path noted above the story. Stories
// are treated as ground truth for what the product looks like, so one that
// composes an unreachable state makes every visual comparison built on it
// wrong. If the app changes and a story no longer matches a reachable state,
// fix the story or delete it — do not keep both "the app" and "the story
// version" of a surface alive. Where a story deliberately puts several states
// side by side for review, say so: the arrangement is a scaffold, each panel
// is the reachable state.

const meta = {
  title: 'Product/Capability Audit Strip',
  parameters: {
    layout: 'fullscreen',
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

const NOW = Date.now();

function report(input: Partial<CapabilityAuditReport['summary']>): CapabilityAuditReport {
  return {
    checkedAt: NOW,
    sources: [],
    skills: [],
    automations: [],
    summary: {
      sourceCount: 0,
      readySourceCount: 0,
      needsAuthSourceCount: 0,
      errorSourceCount: 0,
      disabledSourceCount: 0,
      skillCount: 0,
      enabledSkillCount: 0,
      skillsWithDeclaredTools: 0,
      declaredToolKindCount: 0,
      automationCount: 0,
      enabledAutomationCount: 0,
      executableAutomationCount: 0,
      failedAutomationCount: 0,
      skippedAutomationCount: 0,
      ...input,
    },
  };
}

function StripFrame(props: { children: React.ReactNode }) {
  return (
    <div
      data-maka-e2e-fixture="true"
      style={{
        background: 'var(--surface-canvas)',
        padding: 24,
        width: '100%',
        maxWidth: 720,
        margin: '0 auto',
      }}
    >
      {props.children}
    </div>
  );
}

// Real path: sidebar → 扩展 → 技能 — the strip sits above the skills list (skills-panel.tsx)
// and summarizes what is installed and enabled.
export const SkillsFocusHealthy: Story = {
  render: () => (
    <StripFrame>
      <CapabilityAuditStrip
        report={report({
          sourceCount: 3,
          readySourceCount: 3,
          skillCount: 8,
          enabledSkillCount: 6,
          skillsWithDeclaredTools: 5,
          declaredToolKindCount: 4,
        })}
      />
    </StripFrame>
  ),
};

// Real path: sidebar → 定时任务 → 计划提醒 — the same strip above the reminder list
// (plan-reminder-panel.tsx), so its numbers describe automations instead.
export const AutomationsFocusHealthy: Story = {
  render: () => (
    <StripFrame>
      <CapabilityAuditStrip
        report={report({
          sourceCount: 2,
          readySourceCount: 2,
          automationCount: 5,
          enabledAutomationCount: 4,
          executableAutomationCount: 4,
        })}
      />
    </StripFrame>
  ),
};

// Real path: either of those two pages once something needs attention — a managed skill
// source needing auth or erroring, or an automation whose last run failed or was
// skipped.
export const WithRisks: Story = {
  render: () => (
    <StripFrame>
      <CapabilityAuditStrip
        report={report({
          sourceCount: 4,
          readySourceCount: 2,
          needsAuthSourceCount: 1,
          errorSourceCount: 1,
          skillCount: 10,
          enabledSkillCount: 7,
          skillsWithDeclaredTools: 6,
          declaredToolKindCount: 5,
          automationCount: 6,
          enabledAutomationCount: 5,
          executableAutomationCount: 4,
          failedAutomationCount: 1,
          skippedAutomationCount: 1,
        })}
      />
    </StripFrame>
  ),
};

// Real path: either page on a fresh install, with nothing installed and nothing
// scheduled.
export const Empty: Story = {
  render: () => (
    <StripFrame>
      <CapabilityAuditStrip report={report({})} />
    </StripFrame>
  ),
};
