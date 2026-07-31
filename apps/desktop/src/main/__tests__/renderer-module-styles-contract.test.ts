import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { resolve } from 'node:path';
import postcss from 'postcss';
import { readCssTree, RENDERER_STYLES_DIR, stripCssComments } from './css-test-helpers.js';

const MODULE_PAGES_ENTRY = resolve(RENDERER_STYLES_DIR, 'module-pages.css');
const MODULE_PAGES_DIR = resolve(RENDERER_STYLES_DIR, 'module-pages');

const EXPECTED_MODULE_PAGE_IMPORTS = [
  './module-pages/plan-reminders.css',
  './module-pages/capability-audit.css',
  './module-pages/module-shell.css',
  './module-pages/skills.css',
  './module-pages/mcp.css',
];

const MODULE_OWNER_SELECTOR_RE = /\.(?:maka-(?:plan|skill|mcp|module|capability)|maka-panel-detail)\b/;
const FORBIDDEN_MODULE_SELECTOR_RE = /:where\(\s*input|\.settingsSelect|\.maka-chat-(?:header|status)|\.maka-model-switcher|\.detailPane\b/;

function readCssImports(source: string): string[] {
  return [...source.matchAll(/@import\s+"([^"]+)";/g)].map((match) => match[1]);
}

function findModuleOwnerSelectorViolations(file: string, source: string): string[] {
  const violations: string[] = [];
  const root = postcss.parse(source, { from: file });
  root.walkRules((rule) => {
    for (const selector of postcss.list.comma(rule.selector)) {
      if (FORBIDDEN_MODULE_SELECTOR_RE.test(selector)) {
        violations.push(`${file}: ${selector}`);
        continue;
      }
      if (!MODULE_OWNER_SELECTOR_RE.test(selector)) {
        violations.push(`${file}: ${selector}`);
      }
    }
  });
  return violations;
}

describe('renderer module styles contract', () => {
  it('keeps module-pages.css as an ordered import manifest', async () => {
    const source = await readFile(MODULE_PAGES_ENTRY, 'utf8');

    assert.deepEqual(readCssImports(source), EXPECTED_MODULE_PAGE_IMPORTS);

    const nonImportSource = stripCssComments(source)
      .replace(/@import\s+"[^"]+";\s*/g, '')
      .trim();

    assert.equal(
      nonImportSource,
      '',
      'module-pages.css should only import focused module style files; put new rules in the owned child stylesheet.',
    );
  });

  it('keeps module-pages child styles scoped to module-page owners', async () => {
    const violations: string[] = [];

    for (const file of await readCssTree(MODULE_PAGES_DIR)) {
      const source = await readFile(file, 'utf8');
      violations.push(...findModuleOwnerSelectorViolations(file, source));
    }

    assert.deepEqual(
      violations,
      [],
      'styles/module-pages/** must only contain module-page owned selectors. Move global focus, SettingsSelect, chat header, model switcher, and shared shell rules to their real owner stylesheet.',
    );
  });


});
