import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { readRendererContractCss } from './contract-css-helpers.js';

const REPO_ROOT = join(process.cwd(), '..', '..');

async function readRepo(relativePath: string): Promise<string> {
  return readFile(join(REPO_ROOT, relativePath), 'utf8');
}

function ruleBody(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`${escaped}\\s*\\{([\\s\\S]*?)\\}`).exec(css);
  assert.ok(match, `${selector} rule should exist`);
  return match[1] ?? '';
}

describe('session health notice layout contract (#1032)', () => {
  it('removes the chat header status cluster and fake-backend banner', async () => {
    const chat = await readRepo('packages/ui/src/chat-view.tsx');
    assert.doesNotMatch(chat, /maka-chat-status-cluster/);
    assert.doesNotMatch(chat, /sessionStatusBadge|connectionAlert|eventStreamAlert/);
    assert.doesNotMatch(chat, /maka-fake-backend-banner|isLocalSimulationBackend/);
    assert.doesNotMatch(chat, /SessionStatusBadge|ChatHeaderAlertBadge|ChatHeaderAlert/);
  });

  it('mounts the hard-only health notice above the composer interaction slot', async () => {
    const shell = await readRepo('apps/desktop/src/renderer/app-shell.tsx');
    const surface = await readRepo('apps/desktop/src/renderer/chat-message-surface.tsx');
    const composerRegion = await readRepo('apps/desktop/src/renderer/chat-composer-region.tsx');
    const surfaceIndex = shell.indexOf('<ChatMessageSurface');
    const composerRegionIndex = shell.indexOf('<ChatComposerRegion');
    assert.ok(surfaceIndex >= 0, 'ChatMessageSurface should render in app-shell');
    assert.ok(composerRegionIndex >= 0, 'ChatComposerRegion should render in app-shell');
    assert.ok(
      surfaceIndex < composerRegionIndex,
      'the message surface (with its health notice) must sit above the composer region',
    );
    assert.match(
      shell,
      /navSelection\.section === 'automations' && navSelection\.module === 'daily-review' \?[\s\S]*<ChatMessageSurface/,
      'the message surface must stay on the conversation surface, not Skills/Automations/Daily Review',
    );
    assert.match(
      surface,
      /className="maka-session-health-notice"[\s\S]*?role="status"/,
    );
    // U1: every health-notice CTA now routes to 设置 · 模型, so the action
    // label is always the single `goToModels` copy string (the former
    // per-target ternary and its 去账号 branch were retired with the account
    // section). Bound to a local `goToModelsLabel` so the static a11y checker
    // recognizes the button's text label.
    assert.match(surface, /const goToModelsLabel = copy\.goToModels;/);
    assert.match(surface, /\{goToModelsLabel\}/);
    assert.match(composerRegion, /className="maka-composer-interaction-slot"/);
  });

  it('does not surface routine running or event-stream recovery badges', async () => {
    const model = await readRepo('apps/desktop/src/renderer/use-shell-chat-model.ts');
    assert.doesNotMatch(model, /chatEventStreamAlert|事件流恢复中/);
    assert.doesNotMatch(model, /chatConnectionAlert|deriveChatHeaderAlert/);
    assert.match(model, /deriveSessionHealthNotice/);
    assert.match(model, /sessionHealthNotice/);

    const shell = await readRepo('apps/desktop/src/renderer/app-shell.tsx');
    assert.doesNotMatch(shell, /chatSessionStatusBadge|sessionStatusBadge/);
    assert.doesNotMatch(shell, /presentSessionStatus|sessionStatusAriaLabel/);
  });

  it('styles the notice outside the message scroll area', async () => {
    const css = await readRendererContractCss();
    assert.doesNotMatch(css, /\.maka-chat-status-cluster\b/);
    assert.doesNotMatch(css, /\.maka-fake-backend-banner\b/);
    assert.doesNotMatch(css, /\.maka-chat-header-alert\b/);
    assert.doesNotMatch(css, /\.maka-chat-header-status\b/);
    const body = ruleBody(css, '.maka-session-health-notice');
    assert.doesNotMatch(body, /position:\s*absolute/);
    assert.match(body, /margin:/);
  });
});
