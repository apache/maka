import type { Meta, StoryObj } from '@storybook/react-vite';
import type { CapabilityAuditReport } from '@maka/core';
import { CapabilityAuditStrip } from '../src/capability-audit-strip.js';

// Fidelity convention (#1433): every story below names the real app path
// that reaches it. See apps/desktop/stories/FIDELITY.md.
//
// This file had four stories and three of them rendered nothing. The strip
// reports by exception — `capabilityAuditIssues` returns [] and the component
// returns null unless a source needs auth or is erroring, or an automation
// failed or was skipped — and `report()` defaults all four of those counts to
// 0. So `SkillsFocusHealthy`, `AutomationsFocusHealthy` and `Empty` were blank
// panels carrying confident "Real path:" sentences that described behavior the
// component lost when it stopped summarizing healthy state. The app state they
// named is "this strip is not on the page", which needs no story.

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

/**
 * The skills page's frame: the element the strip is a direct child of in
 * skills-panel.tsx. Not an approximation of one — the previous frame here was
 * a `maxWidth: 720; padding: 24` box the app never renders, plus
 * `data-maka-e2e-fixture`, which pauses every animation and transition
 * (base.css), something only the E2E harness does.
 *
 * This is the skills host and only the skills host. The plan-reminder page
 * mounts the same component in a different frame — `.maka-plan-shell
 * .agents-inner-view-clamp` inside `.maka-plan-panel`, which caps it at
 * `min(100%, 1024px)` centred (reference-shell.css) and has no
 * `.maka-module-main` ancestor, so `module-shell.css`'s
 * `:has(> .maka-capability-audit-strip)` third grid row does not apply there.
 * Width and vertical-rhythm measurements taken here do not transfer to that
 * page. A second story would only be worth its scaffold if someone were doing
 * pixel work on the plan page; naming the divergence is what stops a
 * measurement here from being quietly reused there.
 */
function ModulePage(props: { children: React.ReactNode }) {
  return (
    <main className="maka-main detailPane maka-module-main agents-chat-panel">{props.children}</main>
  );
}

// Real path: sidebar → 扩展 → 技能, once something needs attention — a managed
// skill source waiting for auth or erroring, an automation whose last run failed
// or was skipped. The strip renders exactly one warning line naming what is
// wrong. With all four of those counts at zero it returns null and the page
// carries no strip, so that state has no story: it has no pixels.
//
// 定时任务 → 计划提醒 reaches the same component in a different frame; see
// ModulePage above for what that changes and why it is not a second story.
export const WithRisks: Story = {
  render: () => (
    <ModulePage>
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
    </ModulePage>
  ),
};
