import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ReactNode } from 'react';
import {
  AutomationsPage,
  getSharedUiCopy,
  ModuleHubSelector,
  SkillsPage,
  ToastProvider,
  useUiLocale,
} from '@maka/ui';

// Fidelity convention (#1433): every story below names the real app path
// that reaches it. See apps/desktop/stories/FIDELITY.md.

const meta = {
  title: 'Product/Module Hubs',
  parameters: { layout: 'fullscreen' },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

function Surface(props: { children: ReactNode; agentsView: 'skills' | 'cron' }) {
  return (
    <div
      data-maka-e2e-fixture="true"
      className="maka-panel maka-panel-detail maka-floating-panel agents-content-area agents-parchment-paper-surface"
      data-agents-view={props.agentsView}
      style={{ width: '100%', height: '100vh', minHeight: 720 }}
    >
      <ToastProvider>{props.children}</ToastProvider>
    </div>
  );
}

function ExtensionsSkillsSurface() {
  const copy = getSharedUiCopy(useUiLocale()).moduleHubs.extensions;
  return (
    <Surface agentsView="skills">
      <SkillsPage
        hubHeader={{
          title: copy.title,
          subtitle: copy.description,
          badge: <ModuleHubSelector hub="extensions" value="skills" onChange={() => {}} />,
        }}
        skills={[]}
        managedSkillSources={[]}
        bundledSkillCatalog={[]}
      />
    </Surface>
  );
}

function ScheduledPlanRemindersSurface() {
  const copy = getSharedUiCopy(useUiLocale()).moduleHubs.automations;
  return (
    <Surface agentsView="cron">
      <AutomationsPage
        hubHeader={{
          title: copy.title,
          subtitle: copy.description,
          badge: <ModuleHubSelector hub="automations" value="plan-reminders" onChange={() => {}} />,
        }}
        skills={[]}
        reminders={[]}
      />
    </Surface>
  );
}

// Real path: sidebar → 扩展 → 技能.
export const ExtensionsSkills: Story = { render: () => <ExtensionsSkillsSurface /> };

// Real path: sidebar → 定时任务 → 计划提醒.
export const ScheduledPlanReminders: Story = { render: () => <ScheduledPlanRemindersSurface /> };
