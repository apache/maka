/**
 * Chat / workspace chrome layout contracts demoted from Electron e2e.
 *
 * These outcomes used to be measured with getBoundingClientRect after a cold
 * start. The load-bearing fixes are pure CSS or source structure: pin them
 * here. Keep content-visibility pin/warm-up and focus restoration in e2e.
 */
import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { REPO_ROOT, stripCssComments } from './css-test-helpers.js';

const STYLES = resolve(REPO_ROOT, 'apps/desktop/src/renderer/styles');
const CHROME_ACTIONS = resolve(
  REPO_ROOT,
  'apps/desktop/src/renderer/app-shell-chrome-actions.tsx',
);

async function readCss(name: string): Promise<string> {
  return stripCssComments(await readFile(resolve(STYLES, name), 'utf8'));
}

describe('chat shell layout contracts', () => {
  it('keeps ChatLayout flex contracts that kill the phantom dock range', async () => {
    const css = await readCss('chat-header.css');
    assert.match(
      css,
      /\.maka-chat-layout\s*\{[\s\S]*?display:\s*flex;[\s\S]*?flex-direction:\s*column;[\s\S]*?min-height:\s*0;/,
      'chat layout must be a column flex host with min-height 0',
    );
    assert.match(
      css,
      /\.maka-chat-layout\s*>\s*:first-child\s*\{[\s\S]*?min-height:\s*0;[\s\S]*?flex:\s*1\s+0\s+auto;/,
      'message area must flex without a 100% min-height phantom',
    );
    assert.match(
      css,
      /\.maka-chat-layout\s*>\s*:last-child\s*\{[\s\S]*?flex-shrink:\s*0;/,
      'composer/dock row must not shrink under the message area',
    );
  });

  it('keeps the project catalog as the only scroll region in the workspace menu', async () => {
    const css = await readCss('composer.css');
    assert.match(
      css,
      /\.maka-composer-project-scroll\s*\{[\s\S]*?max-height:\s*224px;[\s\S]*?overflow-y:\s*auto;/,
      'project list must scroll inside a capped region',
    );
  });

  it('caps the narrow session workbar so it cannot own the viewport', async () => {
    const css = await readCss('chat-detail.css');
    assert.match(
      css,
      /@media\s*\(\s*max-width:\s*990px\s*\)\s*\{[\s\S]*?\.maka-session-workbar\s*\{[\s\S]*?max-height:\s*min\(\s*42dvh\s*,\s*360px\s*\);/,
      'narrow workbar must stay under 42dvh',
    );
  });

  it('keeps model picker marks square and labels ellipsized', async () => {
    const css = await readCss('model-switcher.css');
    assert.match(
      css,
      /\.modelPickerProviderMark\s*\{[\s\S]*?width:\s*1rem;[\s\S]*?height:\s*1rem;[\s\S]*?flex:\s*0\s+0\s+1rem;/,
      'provider marks must be a fixed 1rem square',
    );
    assert.match(
      css,
      /\.modelPickerOptionLabel\s*\{[\s\S]*?overflow:\s*hidden;[\s\S]*?text-overflow:\s*ellipsis;[\s\S]*?white-space:\s*nowrap;/,
      'long model labels must ellipsize',
    );
  });

  it('keeps bot onboarding QR frames square and image-filling', async () => {
    const css = await readCss('settings/bot.css');
    assert.match(
      css,
      /\.settingsBotOnboardingQrFrame\s*\{[\s\S]*?width:\s*284px;[\s\S]*?height:\s*284px;[\s\S]*?place-items:\s*center;/,
      'QR frame must be a fixed square',
    );
    assert.match(
      css,
      /\.settingsBotOnboardingQrFrame\s+img\s*\{[\s\S]*?width:\s*100%;[\s\S]*?height:\s*100%;[\s\S]*?object-fit:\s*contain;/,
      'QR image must fill its frame',
    );
  });

  it('folds workspace secondary actions into one overflow menu in source', async () => {
    const source = await readFile(CHROME_ACTIONS, 'utf8');
    assert.match(
      source,
      /export function AppShellWorkspaceTopActions/,
      'workspace top actions component must exist',
    );
    assert.match(source, /copy\.moreActions/, 'overflow trigger must be the more-actions control');
    assert.match(source, /copy\.feedback/);
    assert.match(source, /copy\.openCommandPalette/);
    assert.match(source, /copy\.openHelp/);
    assert.match(source, /copy\.openHealth/);
    // Secondary actions only enter the menu, never as sibling IconButtons.
    assert.doesNotMatch(
      source,
      /AppShellWorkspaceTopActions[\s\S]*?onOpenFeedback[\s\S]*?<IconButton[\s\S]*?onOpenFeedback/,
      'feedback must not be a resident IconButton',
    );
    assert.match(
      source,
      /workbarAvailable\s*&&\s*\([\s\S]*?<IconButton[\s\S]*?workbarLabel/,
      'workbar toggle mounts only when a session workbar is available',
    );
    // Exactly one DropdownMenu in the workspace toolbar path.
    const menuCount = (source.match(/<DropdownMenu\b/g) ?? []).length;
    assert.equal(menuCount, 1, 'workspace actions must use one overflow DropdownMenu');
  });
});
