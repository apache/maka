import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { LocaleProvider } from '../locale-context.js';
import type { SkillEntry } from '../module-panel-types.js';
import { SkillInspector } from '../skill-inspector.js';
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

const BUNDLED_ENTRY = {
  id: 'git-flow',
  name: 'Git Flow',
  description: 'Branching workflow helpers.',
  category: '效率工具' as const,
  declaredTools: ['Bash'],
  installed: false,
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

function renderInspector(overrides: Partial<ComponentProps<typeof SkillInspector>> = {}): string {
  return renderToStaticMarkup(
    <LocaleProvider locale="en">
      <ToastProvider>
        <SkillInspector
          skill={INSTALLED_SKILL}
          onUse={() => {}}
          onSetEnabled={() => {}}
          onTogglePinned={() => {}}
          onOpen={() => {}}
          onDelete={() => {}}
          {...overrides}
        />
      </ToastProvider>
    </LocaleProvider>,
  );
}

describe('Skills page shell', () => {
  it('renders the layout page shell with the source switch in a fixed toolbar', () => {
    const markup = render();

    // The Astryx Layout page shell, same as 定时任务: scroll containment is
    // the shell's job, so the view switch can never scroll away (#2236).
    assert.match(markup, /maka-module-page/);
    assert.match(markup, /maka-module-page-bar/);
    assert.match(markup, /aria-label="Skill views"/);
    assert.match(markup, />Marketplace</);
    assert.match(markup, />Built in</);
    assert.match(markup, />Installed</);
    // The hand-rolled scroll container that swallowed the tab bar is gone.
    assert.doesNotMatch(markup, /maka-skill-library"/);
    assert.doesNotMatch(markup, /maka-skill-tabs-bar/);
  });

  it('carries a live installed count beside the title instead of a subtitle', () => {
    const markup = render();

    assert.match(markup, /1 installed/);
    assert.doesNotMatch(markup, /Install and manage skills to extend Maka/);
  });

  it('keeps search in the toolbar with the view switch', () => {
    const markup = render();

    // Order is the contract: view switch, then search, then the rows —
    // search rides the fixed toolbar, never the scrolling list.
    const viewSwitch = markup.indexOf('aria-label="Skill views"');
    const search = markup.indexOf('>Search skills</label>');
    const rows = markup.indexOf('aria-label="Skill list"');
    assert.ok(viewSwitch !== -1 && search !== -1 && rows !== -1);
    assert.ok(viewSwitch < search && search < rows);
  });
});

describe('Skills installed rows', () => {
  it('rows are selectable and otherwise inert: no switch, menu, or use button', () => {
    const markup = render();

    assert.doesNotMatch(markup, /role="switch"/);
    assert.doesNotMatch(markup, /More actions for Test Skill/);
    assert.doesNotMatch(markup, /Use Test Skill in chat/);
    assert.doesNotMatch(markup, /role="menu"/);
    // Selecting the row is the one gesture: the row itself is the target.
    assert.match(markup, /<li[^>]*>/);
  });

  it('keeps normal state on the status dot and leads exceptional state as text', () => {
    const quiet = render();
    // Enabled + in context is the normal case: no status prose on the row.
    assert.doesNotMatch(quiet, />Enabled</);
    assert.doesNotMatch(quiet, />In context</);

    const attention = render([{
      ...INSTALLED_SKILL,
      sourceType: 'managed',
      managedUpdateStatus: 'update_available',
    }]);
    assert.match(attention, /Update available/);
  });

  it('renders scope and source as supporting text rather than status chips', () => {
    const markup = render();

    assert.match(markup, /Workspace · Local/);
    assert.doesNotMatch(markup, /aria-label="Workspace"/);
    assert.doesNotMatch(markup, /aria-label="Local"/);
  });
});

describe('Skill inspector', () => {
  it('owns every per-skill action with room for real labels', () => {
    const markup = renderInspector();

    assert.match(markup, /role="switch"/);
    assert.match(markup, />Use</);
    assert.match(markup, /Open SKILL.md/);
    assert.match(markup, /Pin to the skill context/);
    assert.match(markup, /Delete/);
  });

  it('keeps managed update review reachable from the inspector', () => {
    const markup = renderInspector({
      skill: {
        ...INSTALLED_SKILL,
        sourceType: 'managed',
        managedUpdateStatus: 'update_available',
      },
      onPreviewUpdate: () => {},
    });

    assert.match(markup, /View update/);
  });

  it('does not offer invocation for a disabled Skill', () => {
    const markup = renderInspector({
      skill: {
        ...INSTALLED_SKILL,
        contextStatus: 'disabled',
        enabled: false,
        runtimeStatus: 'disabled',
      },
    });

    assert.doesNotMatch(markup, />Use</);
  });
});

describe('Skills catalog rows', () => {
  it('keeps install as the single action on a built-in catalog row', () => {
    const markup = render([], { bundledSkillCatalog: [BUNDLED_ENTRY] });

    assert.match(markup, /Install Git Flow/);
    assert.doesNotMatch(markup, /role="switch"/);
    assert.doesNotMatch(markup, /More actions/);
  });
});
