// Session health notice E2E (#1038) — one representative journey across
// the renderer/main boundary: the notice above the composer must answer
// "will the next send fail?" from the same facts as the send gate
// (connection list, hasSecret probe, connectionLocked on the summary).
//
// The stale-sessions e2e-fixture seeds the exact on-disk states: one
// locked fake-backend session and one healthy ai-sdk session. The stale
// session carries user messages, so storage self-heals it to
// `connectionLocked: true` on first read — the send can neither use its
// connection nor silently rebind, even though a healthy default
// connection exists. The old "default exists && enabled" proxy hid the
// notice in exactly this state (#1038 case 1); it must now show.
// The deleted-connection and legacy-backend notice variants are covered
// by deriveSessionHealthNotice unit tests.

import { test, expect } from './fixtures';

// The notice is a PEER of the composer form (both are children of
// `.mainColumn`), not a child of it, so nothing inherits the composer's
// measure for it — it has to opt in with the same
// `min(--maka-chat-measure, 100% - 2*--space-6)` box. It shipped with a bare
// `margin: 0 var(--space-3)` instead, so on any window wider than the 680px
// measure the notice ran the full chat column while the composer card stayed
// centered at 680 — two mismatched edges stacked on each other. Left/right
// edges are the assertion; width alone would pass a notice that is the right
// size but off-center.
async function probeNoticeAlignment(page: import('@playwright/test').Page) {
  return await page.evaluate(() => {
    const notice = document.querySelector<HTMLElement>('.maka-session-health-notice');
    const composer = document.querySelector<HTMLElement>('.composer .maka-composer-astryx');
    if (!notice || !composer) {
      throw new Error('Expected both the health notice and the composer card to be mounted');
    }
    const noticeBox = notice.getBoundingClientRect();
    const composerBox = composer.getBoundingClientRect();
    return {
      leftDelta: Math.abs(noticeBox.left - composerBox.left),
      rightDelta: Math.abs(noticeBox.right - composerBox.right),
    };
  });
}

test('a locked stale session shows the health notice even with a ready default', async ({ staleSessionsWindow: page }) => {
  // Active = stale fake session (locked by its history): notice shows.
  await expect(page.getByText('会话已过期 · 请先配置真实模型')).toBeVisible();

  // The notice shares the composer card's edges — see probeNoticeAlignment.
  const alignment = await probeNoticeAlignment(page);
  expect(alignment.leftDelta).toBeLessThanOrEqual(1);
  expect(alignment.rightDelta).toBeLessThanOrEqual(1);

  // A healthy session must not show the notice.
  await page.getByRole('button', { name: '展开侧边栏' }).click();
  await page.getByText('正常会话（Z.ai Live）').first().click();
  await expect(page.getByText('会话已过期 · 请先配置真实模型')).toBeHidden();

  // Back on the stale session, click-through lands in Settings · 模型.
  await page.getByText('旧的本地模拟会话').first().click();
  await expect(page.getByText('会话已过期 · 请先配置真实模型')).toBeVisible();
  await page.getByRole('button', { name: '去模型' }).click();
  await expect(page.getByLabel('设置内容')).toBeVisible();
  // The connection list itself, not just the settings shell: `add-connection`
  // is the list level's own affordance, so it can only be visible once the
  // panel has loaded and settled on that route.
  await expect(page.locator('[data-maka-contract="add-connection"]')).toBeVisible();
});
