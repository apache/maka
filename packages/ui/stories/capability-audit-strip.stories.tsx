import type { Meta, StoryObj } from '@storybook/react-vite';
import type { CapabilityAuditReport } from '@maka/core/capability-audit';
import { CapabilityAuditStrip } from '../src/capability-audit-strip.js';

// Fidelity convention (#1433): every story below names the real app path
// that reaches it. See apps/desktop/stories/FIDELITY.md.
//
// This file had four stories and three of them rendered nothing. The strip
// reports by exception — `capabilityAuditIssues` returns [] and the component
// returns null unless a source needs auth or is erroring, or a scheduled task
// failed or was skipped — and `report()` defaults all four of those counts to
// 0. So the former healthy-focus and empty stories were blank
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
    scheduledTasks: [],
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
      scheduledTaskCount: 0,
      enabledScheduledTaskCount: 0,
      executableScheduledTaskCount: 0,
      failedScheduledTaskCount: 0,
      skippedScheduledTaskCount: 0,
      ...input,
    },
  };
}

/**
 * The skills page's frame: the wrapper the strip renders inside on the real
 * page (skills-panel.tsx) — `.maka-module-page-panel`, a padded grid block
 * in the module page's single scrolling content column. The previous frame
 * here exercised a `.maka-module-main` grid row assignment and its
 * `:has(> .maka-capability-audit-strip)` third-row rule; both were deleted
 * when the module pages moved onto the Astryx Layout shell (#2236), where
 * the strip is ordinary content, not a grid row.
 *
 * What this frame does not reproduce: the 900px centred column, which is
 * Astryx LayoutContent's own box. Width measurements taken here do not
 * transfer to the app; the strip's internal rhythm does. The scheduled-task
 * page mounts the same component inside `.maka-module-page-body` — a
 * different padded block in the same kind of column — and the same caveat
 * applies there.
 */
function ModulePage(props: { children: React.ReactNode }) {
  return (
    <main className="maka-main detailPane maka-module-main agents-chat-panel" data-page-shell="layout">
      <div className="maka-module-page-panel">{props.children}</div>
    </main>
  );
}

// Real path: sidebar → 扩展 → 技能, once something needs attention — a managed
// skill source waiting for auth or erroring, a scheduled task whose last run failed
// or was skipped. The strip renders exactly one warning line naming what is
// wrong. With all four of those counts at zero it returns null and the page
// carries no strip, so that state has no story: it has no pixels.
//
// 定时任务 → 定时任务 reaches the same component in a different frame; see
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
          scheduledTaskCount: 6,
          enabledScheduledTaskCount: 5,
          executableScheduledTaskCount: 4,
          failedScheduledTaskCount: 1,
          skippedScheduledTaskCount: 1,
        })}
      />
    </ModulePage>
  ),
};
