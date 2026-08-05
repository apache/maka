import { test, expect, COMPOSER_INPUT } from './fixtures';

/**
 * #2205 regression: the floating "New messages" scroll-to-bottom indicator
 * must clear once the user is back at the bottom, and must never leak into
 * another conversation.
 *
 * Astryx ChatLayout flags `hasNewMessages` whenever the last
 * `.astryx-chat-message` node changes while the scroller is unlocked, and used
 * to clear it only through the button's `dismiss()`. The fix (a) clears the
 * flag on every re-lock (`scrollend` settled within the lock threshold, i.e.
 * the user is at the bottom), and (b) resets the new-message baseline and
 * scroll lock on conversation switches: Maka passes the active session id as
 * `conversationKey` to ChatLayout, which re-locks the scroll and clears the
 * previous conversation's flag and last-message baseline without remounting
 * the layout (a remount would drop an in-progress composer draft).
 *
 * Button names are Astryx's shipped en catalog ("New messages" / "Scroll to
 * bottom"); Maka's Astryx overrides do not cover these keys.
 *
 * The `window` fixture starts an empty session whose composer send path is
 * exercised by send-message.spec.ts; this spec first grows the transcript
 * past the viewport with an over-long message so the scroll-to-bottom
 * affordances actually come into play.
 */

function scrollToTop(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const el = document.querySelector<HTMLElement>('[data-chat-scroll-container="true"]');
    if (!el) throw new Error('chat scroll container not found');
    el.scrollTop = 0;
    el.dispatchEvent(new Event('scroll'));
  });
}

async function scrollToBottom(page: import('@playwright/test').Page) {
  await page.evaluate(() => {
    const el = document.querySelector<HTMLElement>('[data-chat-scroll-container="true"]');
    if (!el) throw new Error('chat scroll container not found');
    el.scrollTop = el.scrollHeight;
    el.dispatchEvent(new Event('scroll'));
    // scrollend is a UA-dispatched event; the Astryx scroller listens for it
    // natively, and the fixture's programmatic jump does not guarantee the
    // browser emits one, so dispatch it explicitly to settle the lock.
    el.dispatchEvent(new Event('scrollend'));
  });
  // Astryx's synthetic-scroll guard bails out of the scroll handler while
  // scrollHeight is still changing, which a programmatic jump right after the
  // reply settles can trip; a real user's scroll keeps firing until the
  // layout stops. Drive one more cycle after the layout settles so
  // `isScrolledUp` follows the final position.
  await page.waitForTimeout(250);
  await page.evaluate(() => {
    const el = document.querySelector<HTMLElement>('[data-chat-scroll-container="true"]');
    el?.dispatchEvent(new Event('scroll'));
    el?.dispatchEvent(new Event('scrollend'));
  });
}

async function growTranscriptOverflow(page: import('@playwright/test').Page) {
  // Short viewport: a handful of normal messages overflow the transcript.
  await page.setViewportSize({ width: 900, height: 420 });
  const composer = page.locator(COMPOSER_INPUT);
  await expect(composer).toHaveAttribute('aria-label', '消息输入框');
  // The fake backend echoes the full input, so keep messages short — a long
  // one streams hundreds of 9-char chunks and stalls the turn for 20s+.
  for (let i = 1; i <= 3; i++) {
    await composer.fill(`make the transcript overflow ${i}`);
    await composer.press('Enter');
    await expect(page.getByText(new RegExp(`Fake backend received: make the transcript overflow ${i}`))).toBeAttached({ timeout: 20_000 });
    // The settle signal is the turn footer switching to its settled action
    // ("重新生成"): exactly i settled turns after the i-th reply. Counting (not
    // .last()) also proves every earlier turn settled, and .maka-bubble-streaming
    // is unusable here — it can read 0 before the stream even starts.
    await expect(page.getByRole('button', { name: '重新生成' })).toHaveCount(i, { timeout: 20_000 });
    const { sh, ch } = await page.evaluate(() => {
      const el = document.querySelector<HTMLElement>('[data-chat-scroll-container="true"]');
      return el ? { sh: el.scrollHeight, ch: el.clientHeight } : { sh: 0, ch: 0 };
    });
    if (sh > ch) return;
  }
  throw new Error('transcript did not overflow the short viewport after 3 messages');
}

test('clears the "New messages" indicator once the user scrolls back to the bottom', async ({ window: page }) => {
  // Grow the transcript past the viewport, then pin to the bottom (the
  // fixture boots there): no indicator.
  await growTranscriptOverflow(page);
  await scrollToBottom(page);
  await expect(page.getByRole('button', { name: 'New messages' })).toHaveCount(0);

  // Scroll up: the scroller unlocks and the plain scroll-to-bottom button
  // appears.
  await scrollToTop(page);
  await expect(page.getByRole('button', { name: 'Scroll to bottom' })).toBeVisible();

  // A reply lands while the scroller is unlocked → the indicator flags
  // "New messages". The reply renders at the bottom of the transcript, which
  // is out of view after the scroll-up, so assert attachment, not visibility.
  const composer = page.locator(COMPOSER_INPUT);
  await expect(composer).toHaveAttribute('aria-label', '消息输入框');
  await composer.fill('trigger new-message indicator');
  await composer.press('Enter');
  await expect(page.getByText(/Fake backend received: trigger new-message indicator/)).toBeAttached();
  await expect(page.getByRole('button', { name: 'New messages' })).toBeVisible();
  // Let this reply settle too: if it were still streaming, the final
  // scrollend's distance-from-bottom read could land above the lock threshold
  // mid-chunk and skip the re-lock this test asserts.
  await expect(page.getByRole('button', { name: '重新生成' }).last()).toBeAttached({ timeout: 20_000 });

  // Scroll all the way back down: scrollend settles within the lock threshold
  // → auto-follow re-locks → the indicator must clear (#2205).
  await scrollToBottom(page);
  await expect(page.getByRole('button', { name: 'New messages' })).toHaveCount(0);
});

test('does not leak the indicator into a new conversation', async ({ window: page }) => {
  // Build the flagged state: a long transcript, scrolled up, then a new reply
  // while unlocked.
  await growTranscriptOverflow(page);
  await scrollToTop(page);
  const composer = page.locator(COMPOSER_INPUT);
  await expect(composer).toHaveAttribute('aria-label', '消息输入框');
  await composer.fill('flag this conversation');
  await composer.press('Enter');
  await expect(page.getByText(/Fake backend received: flag this conversation/)).toBeAttached();
  await expect(page.getByRole('button', { name: 'New messages' })).toBeVisible();

  // Start a brand-new conversation from the sidebar.
  const expand = page.getByRole('button', { name: '展开侧边栏' });
  if (await expand.count()) await expand.click();
  await page.getByRole('button', { name: '新任务' }).click();
  await expect(composer).toHaveAttribute('aria-label', '消息输入框');

  // The fresh conversation must not inherit the indicator…
  await expect(page.getByRole('button', { name: 'New messages' })).toHaveCount(0);

  // …and its first message must not re-trigger it while pinned at the bottom.
  await composer.fill('first message of the new conversation');
  await composer.press('Enter');
  await expect(page.getByText(/Fake backend received: first message of the new conversation/)).toBeAttached();
  await expect(page.getByRole('button', { name: 'New messages' })).toHaveCount(0);
});
