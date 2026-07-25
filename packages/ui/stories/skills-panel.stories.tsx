import type { Meta, StoryObj } from '@storybook/react-vite';
import { SkillsModuleMain } from '../src/skills-panel.js';
import type { SkillEntry } from '../src/module-panel-types.js';

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
  title: 'Product/Skills',
  parameters: {
    layout: 'fullscreen',
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

const noop = () => undefined;

const skills: SkillEntry[] = [
  {
    id: 'skill-git-flow',
    name: 'git-flow',
    description: '封装分支创建、合并与发布打 tag 的常用 git 操作。',
    path: '~/.maka/skills/git-flow',
    declaredTools: ['Bash', 'Write'],
    enabled: true,
    runtimeStatus: 'enabled',
  },
  {
    id: 'skill-docs-screenshot',
    name: 'docs-screenshot',
    description: '把组件截图同步进设计文档，按 token 分类命名。',
    path: '~/.maka/skills/docs-screenshot',
    declaredTools: ['Bash', 'Read'],
    enabled: false,
    runtimeStatus: 'disabled',
  },
  {
    id: 'skill-release-notes',
    name: 'release-notes',
    description: '从最近的 commit 历史生成发布说明草稿。',
    path: '~/.maka/skills/release-notes',
    declaredTools: ['Bash'],
    enabled: true,
    runtimeStatus: 'enabled',
  },
];

function ModuleFrame(props: { children: React.ReactNode }) {
  return (
    <div
      data-maka-e2e-fixture="true"
      style={{
        background: 'var(--surface-canvas)',
        height: '100%',
        minHeight: 560,
      }}
    >
      <div
        className="maka-panel maka-panel-detail maka-floating-panel agents-content-area agents-parchment-paper-surface"
        style={{ height: '100%', overflow: 'auto' }}
      >
        {props.children}
      </div>
    </div>
  );
}

// Real path: sidebar → 扩展 → 技能, with skills installed.
export const Populated: Story = {
  render: () => (
    <ModuleFrame>
      <SkillsModuleMain
        skills={skills}
        onRefreshSkills={noop}
        onCreateSkillTemplate={noop}
        onOpenSkill={noop}
        onOpenSkillsFolder={noop}
      />
    </ModuleFrame>
  ),
};

// Real path: same page on a fresh install, before any skill is installed.
export const Empty: Story = {
  render: () => (
    <ModuleFrame>
      <SkillsModuleMain
        skills={[]}
        onRefreshSkills={noop}
        onCreateSkillTemplate={noop}
        onOpenSkill={noop}
        onOpenSkillsFolder={noop}
      />
    </ModuleFrame>
  ),
};
