import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const sidebarCssUrl = [
  new URL('../../renderer/styles/sidebar.css', import.meta.url),
  new URL('../../../src/renderer/styles/sidebar.css', import.meta.url),
].find((candidate) => existsSync(candidate));

if (!sidebarCssUrl) throw new Error('Could not locate renderer/styles/sidebar.css');

const sidebarCss = readFileSync(sidebarCssUrl, 'utf8');

describe('project-grouped session hierarchy', () => {
  it('aligns session titles with the project name', () => {
    const projectChildrenRule = sidebarCss.match(
      /\.maka-project-row\s*>\s*div\s*>\s*\[role=["']group["']\]\s*>\s*div\s*\{([^}]*)\}/,
    );

    assert.ok(projectChildrenRule, 'project children must have an explicit hierarchy rule');
    // Astryx nests icon-less children by spacing-6 (24px) so their text meets a
    // parent title after a 16px icon + 8px gap. Session rows already spend 8px
    // on StatusDot in that slot, so the remaining nest is spacing-2.
    assert.match(
      projectChildrenRule[1] ?? '',
      /padding-inline-start:\s*var\(--spacing-2\)\s*!important;/,
      'project sessions must nest by the unused 8px of the SideNav icon column',
    );
  });
});
