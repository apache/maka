import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { UiLocale } from '@maka/core';
import { LocaleProvider } from '../locale-context.js';
import {
  ComposerSkillPicker,
  composerSkillKey,
  filterComposerSkills,
} from '../composer-skill-picker.js';

function render(locale: UiLocale, children: ReactNode): string {
  return renderToStaticMarkup(<LocaleProvider locale={locale}>{children}</LocaleProvider>);
}

const skills = [
  { ref: 'user:pdf', id: 'pdf', name: 'PDF 工具', description: '读取与拆分 PDF' },
  { id: 'docx', name: 'Word 文档', description: 'Create and edit .docx files' },
  { id: 'commit', name: 'Commit' },
];

describe('composer skill picker', () => {
  it('keys a selection by its scope-aware ref, falling back to the id', () => {
    assert.equal(composerSkillKey({ ref: 'User:PDF', id: 'pdf' }), 'user:pdf');
    assert.equal(composerSkillKey({ id: 'Commit' }), 'commit');
  });

  it('filters case-insensitively across id, name and description', () => {
    assert.deepEqual(
      filterComposerSkills(skills, 'DOCX').map((skill) => skill.id),
      ['docx'],
    );
    assert.deepEqual(
      filterComposerSkills(skills, '拆分').map((skill) => skill.id),
      ['pdf'],
    );
    // A blank query is not a filter — it returns the full catalog.
    assert.equal(filterComposerSkills(skills, '  ').length, skills.length);
    assert.equal(filterComposerSkills(skills, 'nothing-matches').length, 0);
  });

  it('renders a closed trigger with the selection count and no panel', () => {
    const markup = render(
      'zh',
      <ComposerSkillPicker
        skills={skills}
        selected={[{ ref: 'user:pdf', id: 'pdf', name: 'PDF 工具' }]}
        onToggle={() => {}}
        onSelectAll={() => {}}
        onClearAll={() => {}}
      />,
    );
    assert.match(markup, /maka-composer-skill-trigger/);
    assert.match(markup, /aria-label="技能"/);
    assert.match(markup, /data-selected="true"/);
    assert.match(markup, /maka-composer-skill-trigger-count[^>]*>1</);
    // Closed by default: the panel must not ship in the resting markup, so it
    // cannot contribute to the composer's constant footprint.
    assert.doesNotMatch(markup, /maka-composer-skill-panel/);
    assert.match(markup, /aria-expanded="false"/);
  });

  it('localizes the trigger', () => {
    const en = render(
      'en',
      <ComposerSkillPicker
        skills={skills}
        selected={[]}
        onToggle={() => {}}
        onSelectAll={() => {}}
        onClearAll={() => {}}
      />,
    );
    assert.match(en, /aria-label="Skills"/);
    assert.doesNotMatch(en, /maka-composer-skill-trigger-count/);
  });
});
