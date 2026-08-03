import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { LocaleProvider } from '../locale-context.js';
import type { SkillEntry } from '../module-panel-types.js';
import { SkillsModuleMain } from '../skills-panel.js';
import { ToastProvider } from '../toast.js';

const INSTALLED_SKILL: SkillEntry = {
  ref: 'workspace:maka:test-skill',
  id: 'test-skill',
  name: 'Test Skill',
  description: 'Review a workspace before release.',
  path: '/workspace/skills/test-skill',
  declaredTools: ['Read'],
  sourceType: 'workspace',
  scope: 'workspace',
  contextStatus: 'advertised',
  manageable: true,
  enabled: true,
  runtimeStatus: 'enabled',
};

function render(
  skills: SkillEntry[] = [INSTALLED_SKILL],
  overrides: Partial<ComponentProps<typeof SkillsModuleMain>> = {},
): string {
  return renderToStaticMarkup(
    <LocaleProvider locale="en">
      <ToastProvider>
        <SkillsModuleMain
          skills={skills}
          onOpenSkill={() => {}}
          onUseSkill={() => {}}
          onSetSkillEnabled={() => {}}
          onSetSkillPinned={() => {}}
          onDeleteSkill={() => {}}
          {...overrides}
        />
      </ToastProvider>
    </LocaleProvider>,
  );
}

describe('Skills page interaction hierarchy', () => {
  it('keeps one direct action, one state control, and one contextual menu per installed row', () => {
    const markup = render();

    assert.match(markup, /aria-label="Use Test Skill in chat"/);
    assert.match(markup, /role="switch"/);
    assert.match(markup, /aria-label="More actions for Test Skill"/);
    assert.match(markup, /role="menu" aria-label="More actions for Test Skill"/);
    assert.match(markup, /role="menuitem"[\s\S]*?>Open SKILL.md</);
    assert.match(markup, /role="menuitem"[\s\S]*?>Pin to the skill context</);
    assert.match(markup, /role="menuitem"[\s\S]*?>Delete</);
    assert.doesNotMatch(markup, /aria-label="Open SKILL.md"/);
    assert.doesNotMatch(markup, /aria-label="Delete Test Skill"/);
  });

  it('keeps managed update review in the contextual menu', () => {
    const markup = render([{
      ...INSTALLED_SKILL,
      sourceType: 'managed',
      managedUpdateStatus: 'update_available',
    }], {
      onPreviewManagedSkillUpdate: async () => null,
    });

    assert.match(markup, /role="menuitem"[\s\S]*?>View update</);
    assert.doesNotMatch(markup, /<button[^>]*>View update<\/button>/);
  });

  it('renders scope and source as supporting text rather than status chips', () => {
    const markup = render();

    assert.match(markup, /Workspace · In context · Local/);
    assert.doesNotMatch(markup, /aria-label="Workspace"/);
    assert.doesNotMatch(markup, /aria-label="Local"/);
  });

  it('does not offer invocation for a disabled Skill', () => {
    const markup = render([{
      ...INSTALLED_SKILL,
      contextStatus: 'disabled',
      enabled: false,
      runtimeStatus: 'disabled',
    }]);

    assert.doesNotMatch(markup, /Use Test Skill in chat/);
    assert.match(markup, />Enable Test Skill<\/label>/);
    assert.match(markup, /More actions for Test Skill/);
  });
});
