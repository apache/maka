import type { Page } from '@playwright/test';
import { test, expect, COMPOSER_INPUT } from './fixtures';

async function openSideConversationFromLauncher(page: Page) {
  await page.getByRole('button', { name: '打开工作栏工具' }).click();
  await page.getByRole('menuitem', { name: /侧边对话/ }).click();
  await expect(
    page
      .locator(
        '.maka-workbar-tab[data-active][data-workbar-tab-id^="side-chat:"]',
      )
      .getByRole('tab'),
  ).not.toHaveAttribute('aria-busy', 'true');
}

async function waitForSourceSessionToSettle(page: Page) {
  await expect
    .poll(async () => {
      const [source] = await page.evaluate(() => window.maka.sessions.list());
      return source?.status;
    })
    .not.toBe('running');
}

/**
 * The selection affordance's timing contract, in one transcript: the settle
 * delay, Escape dismissal, composer exemption, the immediate hide when a new
 * selection starts, and scroll-following. Each phase grows the same
 * conversation rather than paying a fresh launch and reseed.
 */
test('the quote layer: settle timing, Escape, immediate hide, and scroll following', async ({
  window: page,
}) => {
  test.slow();
  await page.setViewportSize({ width: 1400, height: 900 });
  const composer = page.locator(COMPOSER_INPUT);
  await composer.fill('selection timing source');
  await composer.press('Enter');

  const reply = page.getByText(/Fake backend received: selection timing source/);
  await expect(reply).toBeVisible();
  await expect(composer).toBeEditable();

  const quoteLayer = page.locator('.maka-quote-actions');
  const selectContents = (locator: typeof reply) =>
    locator.evaluate((element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    });

  // Real drag-select with real mouse events. A drag emits a burst of
  // `selectionchange`, and the gesture below lasts well past the settle delay,
  // so a layer that appeared mid-drag — the original complaint — shows up here.
  let replyBox: { x: number; y: number; width: number; height: number } | null = null;
  await expect
    .poll(async () => {
      replyBox = await reply.boundingBox();
      return replyBox;
    })
    .not.toBeNull();
  if (!replyBox) throw new Error('settled selection reply has no visible bounds');
  const dragY = replyBox.y + replyBox.height / 2;
  await page.mouse.move(replyBox.x + 20, dragY);
  await page.mouse.down();
  for (const dx of [60, 120, 180, 240, 300]) {
    await page.mouse.move(replyBox.x + 20 + dx, dragY);
    await page.evaluate(() =>
      document.dispatchEvent(new Event('selectionchange')),
    );
    await page.waitForTimeout(90);
    await expect(quoteLayer).toBeHidden();
  }
  await page.mouse.up();
  await expect(quoteLayer).toBeVisible();

  // Back to no selection, so the measurement below times a fresh appearance
  // rather than finding the layer this drag already raised.
  await page.evaluate(() => window.getSelection()?.removeAllRanges());
  await expect(quoteLayer).toBeHidden();

  // Timed inside the page: measuring across the driver would fold IPC latency
  // into the delay and make the assertion depend on host load.
  const appearedAfterMs = await reply.evaluate(async (element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    const startedAt = performance.now();
    selection?.addRange(range);
    await new Promise<void>((resolve, reject) => {
      const deadline = startedAt + 3000;
      const poll = () => {
        if (document.querySelector('.maka-quote-actions')) resolve();
        else if (performance.now() > deadline) reject(new Error('quote layer never appeared'));
        else requestAnimationFrame(poll);
      };
      poll();
    });
    return performance.now() - startedAt;
  });
  // A selection that is still moving has not earned the layer yet: this delay
  // is the whole fix for "it appears the instant I select something".
  expect(appearedAfterMs).toBeGreaterThan(300);
  await expect(quoteLayer).toBeVisible();

  // Escape dismisses, and the dismissal holds: the layer used to come back on
  // the next unrelated keystroke because any keyup re-captured the selection.
  await page.keyboard.press('Escape');
  await expect(quoteLayer).toBeHidden();
  await page.keyboard.press('Shift');
  // Real-timer negative window, derived from the hook's SELECTION_SETTLE_MS
  // (350ms): a wrongly re-captured selection would surface the layer once that
  // settle window elapses, so outliving it (with margin) proves the dismissal
  // held.
  await page.waitForTimeout(500);
  await expect(quoteLayer).toBeHidden();

  // Selecting inside the composer must not surface a transcript affordance —
  // and must not leave the previous selection's layer standing either. Same
  // SELECTION_SETTLE_MS-derived negative window as above.
  await composer.fill('drafted text to select');
  await selectContents(composer);
  await page.waitForTimeout(500);
  await expect(quoteLayer).toBeHidden();

  // A new selection hides the layer immediately, not when the next one
  // settles (asserted within a frame — see the phase comment in the history).
  await composer.fill('hide first beta');
  await composer.press('Enter');
  await expect(page.getByText(/Fake backend received: hide first beta/).last()).toBeVisible();
  await waitForSourceSessionToSettle(page);

  const select = (pattern: RegExp) =>
    page
      .getByText(pattern)
      .last()
      .evaluate((element) => {
        const range = document.createRange();
        range.selectNodeContents(element);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
      });

  await select(/Fake backend received: selection timing source/);
  await expect(page.locator('.maka-quote-actions')).toBeVisible();

  const stillVisibleAfterEvent = await page
    .getByText(/Fake backend received: hide first beta/)
    .last()
    .evaluate(async (element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      // Programmatic Selection mutations schedule `selectionchange` as a later
      // task. Dispatch the user-visible event now and inspect its synchronous
      // result, before the 350 ms settle path is allowed to re-show the layer.
      document.dispatchEvent(new Event('selectionchange'));
      return !!document.querySelector('.maka-quote-actions');
    });
  expect(stillVisibleAfterEvent).toBe(false);

  // Scrolling moves the selection, so it must move the layer.
  await page.setViewportSize({ width: 1400, height: 700 });
  // Long enough that the selected turn can be scrolled clear of the scroller
  // (two turns already exist from the phases above).
  for (let i = 0; i < 12; i += 1) {
    await composer.fill(`scroll follow source ${i}`);
    await composer.press('Enter');
    await expect(
      page.getByText(new RegExp(`Fake backend received: scroll follow source ${i}`)).last(),
    ).toBeVisible();
    await waitForSourceSessionToSettle(page);
  }

  await page
    .getByText(/Fake backend received: scroll follow source 9/)
    .last()
    .evaluate((element) => {
      // Centred first: the affordance is owed only to a selection inside the
      // scroller's visible band, and where turn 11 lands depends on the host's
      // font metrics. Without this the test asserts on layout luck.
      element.scrollIntoView({ block: 'center' });
      const range = document.createRange();
      range.selectNodeContents(element);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    });

  await expect(quoteLayer).toBeVisible();

  });

/**
 * Side-conversation entry points and the numbered-tab lifecycle in one
 * window: the command palette, the slash suggestion, the /side command, and
 * the launcher tabs all fork from one settled source turn. The numbered-tab
 * phase runs last because it checks 以后不再询问, which suppresses the close
 * confirmation for the rest of its window.
 */
test('side conversation entry points keep work outside the main transcript', async ({
  window: page,
}) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  const mainComposer = page.locator('.mainColumn').locator(COMPOSER_INPUT);
  await mainComposer.fill('side chat command source');
  await mainComposer.press('Enter');
  await expect(
    page.getByText(/Fake backend received: side chat command source/),
  ).toBeVisible();
  const [sourceSession] = await page.evaluate(() => window.maka.sessions.list());
  expect(sourceSession).toBeDefined();
  await waitForSourceSessionToSettle(page);

  await page.keyboard.press('ControlOrMeta+KeyK');
  await page
    .getByRole('dialog', { name: '命令面板' })
    .getByRole('option', { name: /打开侧边对话/ })
    .click();

  const tab = page.getByRole('tab', { name: '侧边对话' });
  const companion = page.locator('.maka-quote-companion');
  await expect
    .poll(() =>
      companion
        .locator(COMPOSER_INPUT)
        .evaluate((element) => element === document.activeElement),
    )
    .toBe(true);
  await expect(tab).not.toHaveAttribute('aria-busy', 'true');
  await expect(page.getByRole('button', { name: '关闭侧边对话' })).toBeVisible();

  // Close the empty side chat before the next entry point: no content, so no
  // confirmation is owed.
  await page.getByRole('button', { name: '关闭侧边对话', exact: true }).click();
  await expect
    .poll(async () => (await page.evaluate(() => window.maka.sessions.list())).length)
    .toBe(1);

  // Slash suggestion entry.
  await waitForSourceSessionToSettle(page);

  await mainComposer.fill('/si');
  const slashMenu = page.getByRole('listbox', { name: '命令和技能' });
  await expect(slashMenu).toBeVisible();
  await expect(
    slashMenu.getByRole('option', { name: /侧边对话.*不打断主任务/ }),
  ).toBeVisible();
  await mainComposer.press('Enter');

  await expect(page.getByRole('tab', { name: '侧边对话' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(mainComposer).toHaveText('');
  await expect(page.locator('.maka-quote-companion .maka-turn')).toHaveCount(0);
  await expect
    .poll(async () => (await page.evaluate(() => window.maka.sessions.list())).length)
    .toBe(2);

  // Close the empty side chat before the next entry point: no content, so no
  // confirmation is owed.
  await page.getByRole('button', { name: '关闭侧边对话', exact: true }).click();
  await expect
    .poll(async () => (await page.evaluate(() => window.maka.sessions.list())).length)
    .toBe(1);

  // /side opens titled and sends outside the main transcript.
  await waitForSourceSessionToSettle(page);

  await mainComposer.fill('/side explain the renderer boundary');
  await mainComposer.press('Enter');

  const titledTab = page.getByRole('tab', {
    name: 'explain the renderer boundary',
  });
  await expect(titledTab).toHaveAttribute('aria-selected', 'true');
  const titledCompanion = page.locator('.maka-quote-companion');
  await expect(
    titledCompanion.getByText(/Fake backend received: explain the renderer boundary/),
  ).toBeVisible();
  await expect(mainComposer).toHaveText('');

  const sessions = await page.evaluate(() => window.maka.sessions.list());
  const companionSession = sessions.find(
    ({ id, parentSessionId, labels }) =>
      id !== sourceSession?.id &&
      parentSessionId === sourceSession?.id &&
      labels.includes('mode:side_conversation'),
  );
  expect(companionSession?.permissionMode).toBe(sourceSession?.permissionMode);

  const mainMessages = await page.evaluate(
    (sessionId) => window.maka.sessions.readMessages(sessionId),
    sourceSession!.id,
  );
  expect(
    mainMessages.some(
      (message) =>
        message.type === 'user' &&
        'text' in message &&
        message.text.includes('/side'),
    ),
  ).toBe(false);

  // Close the titled fork (it has content, so the confirmation is owed).
  await page.getByRole('button', { name: '关闭explain the renderer boundary', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '关闭侧边对话' }).click();
  await expect
    .poll(async () => (await page.evaluate(() => window.maka.sessions.list())).length)
    .toBe(1);
});

test('numbered side chat tabs keep independent drafts and close policy', async ({
  window: page,
}) => {
  test.slow();
  await page.setViewportSize({ width: 1400, height: 900 });
  const mainComposer = page.locator('.mainColumn').locator(COMPOSER_INPUT);
  await mainComposer.fill('numbered side chat source');
  await mainComposer.press('Enter');
  await expect(
    page.getByText(/Fake backend received: numbered side chat source/),
  ).toBeVisible();
  await waitForSourceSessionToSettle(page);
  const [sourceSession] = await page.evaluate(() => window.maka.sessions.list());
  expect(sourceSession).toBeDefined();

  // Numbered tabs, independent drafts, and the don't-ask-again close.
  await openSideConversationFromLauncher(page);
  const visiblePanel = page.locator('.maka-quote-workbar-panel:not([hidden])');
  await expect(visiblePanel).toBeVisible();
  await expect(visiblePanel.locator('.maka-composer-context-drawer .astryx-token')).toHaveCount(0);
  await expect(page.getByRole('tab', { name: '侧边对话' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect
    .poll(() =>
      visiblePanel
        .locator(COMPOSER_INPUT)
        .evaluate((element) => element === document.activeElement),
    )
    .toBe(true);
  await expect
    .poll(async () => (await page.evaluate(() => window.maka.sessions.list())).length)
    .toBe(2);
  await visiblePanel.locator(COMPOSER_INPUT).fill('first side draft');

  // Each New Tab action creates a separate side chat with its own draft owner.
  await openSideConversationFromLauncher(page);
  await expect(page.getByRole('tab', { name: '侧边对话 2' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect
    .poll(async () => (await page.evaluate(() => window.maka.sessions.list())).length)
    .toBe(3);
  await visiblePanel.locator(COMPOSER_INPUT).fill('second side draft');

  await page.getByRole('tab', { name: '侧边对话', exact: true }).click();
  await expect(visiblePanel.locator(COMPOSER_INPUT)).toHaveText('first side draft');
  await visiblePanel.locator(COMPOSER_INPUT).press('Enter');
  await expect(
    visiblePanel.getByText(/Fake backend received: first side draft/),
  ).toBeVisible();
  await expect(page.getByRole('tab', { name: 'first side draft' })).toBeVisible();

  await expect
    .poll(async () =>
      page.evaluate((sourceSessionId) => {
        return window.maka.sessions.list().then((sessions) => ({
          count: sessions.length,
          companions: sessions
            .filter(
              ({ id, parentSessionId, labels }) =>
                id !== sourceSessionId &&
                parentSessionId === sourceSessionId &&
                labels.includes('mode:side_conversation'),
            )
            .map(({ permissionMode }) => permissionMode)
            .sort(),
        }));
      }, sourceSession!.id),
    )
    .toEqual({
      count: 3,
      companions: [sourceSession!.permissionMode, sourceSession!.permissionMode].sort(),
    });

  await page.getByRole('button', { name: '关闭first side draft', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '关闭侧边对话？' })).toBeVisible();
  await page.getByRole('button', { name: '取消' }).click();
  await expect(page.getByRole('tab', { name: 'first side draft' })).toBeVisible();

  await page.getByRole('button', { name: '关闭first side draft', exact: true }).click();
  await page.getByRole('checkbox', { name: '以后不再询问' }).check();
  await page.getByRole('button', { name: '关闭侧边对话', exact: true }).last().click();
  await expect(page.getByRole('tab', { name: 'first side draft' })).toHaveCount(0);
  await expect(page.getByRole('tab', { name: '侧边对话 2' })).toBeVisible();
  await expect
    .poll(async () => (await page.evaluate(() => window.maka.sessions.list())).length)
    .toBe(2);

  // The second tab kept its independent unsent draft while the first fork ran
  // and was discarded.
  await expect(visiblePanel.locator(COMPOSER_INPUT)).toHaveText('second side draft');
  await visiblePanel.locator(COMPOSER_INPUT).press('Enter');
  await expect(
    visiblePanel.getByText(/Fake backend received: second side draft/),
  ).toBeVisible();
  await expect(page.getByRole('tab', { name: 'second side draft' })).toBeVisible();
  await page.getByRole('button', { name: '关闭second side draft' }).click();
  await expect(page.getByRole('dialog', { name: '关闭侧边对话？' })).toHaveCount(0);
  await expect(
    page.locator('[data-maka-contract="session-workbar-right"]'),
  ).toBeHidden();
  await expect(page.getByRole('button', { name: '展开会话工作栏' })).toBeVisible();
  await expect
    .poll(async () => (await page.evaluate(() => window.maka.sessions.list())).length)
    .toBe(1);
});

test('renderer reload recovers and cleans its orphaned side conversation fork', async ({
  window: page,
}) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  const mainComposer = page.locator('.mainColumn').locator(COMPOSER_INPUT);
  await mainComposer.fill('side chat reload source');
  await mainComposer.press('Enter');
  await expect(page.getByText(/Fake backend received: side chat reload source/)).toBeVisible();
  await waitForSourceSessionToSettle(page);

  await openSideConversationFromLauncher(page);
  const sideComposer = page
    .locator('.maka-quote-workbar-panel:not([hidden])')
    .locator(COMPOSER_INPUT);
  await sideComposer.fill('orphan this temporary fork');
  await sideComposer.press('Enter');
  await expect(
    page.getByText(/Fake backend received: orphan this temporary fork/),
  ).toBeVisible();
  await expect
    .poll(async () => (await page.evaluate(() => window.maka.sessions.list())).length)
    .toBe(2);

  await page.reload();

  await expect(page.locator(COMPOSER_INPUT)).toBeVisible();
  await expect
    .poll(async () => (await page.evaluate(() => window.maka.sessions.list())).length)
    .toBe(1);
  await expect(
    page.locator('.maka-workbar-tab[data-workbar-tab-id^="side-chat:"]'),
  ).toHaveCount(0);
});

test('side chat stages quotes and attachments in one isolated fork', async ({
  window: page,
}) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  const mainComposer = page.locator('.mainColumn').locator(COMPOSER_INPUT);
  await mainComposer.fill('quote companion source one');
  await mainComposer.press('Enter');

  const firstSourceReply = page.getByText(/Fake backend received: quote companion source one/);
  await expect(firstSourceReply).toBeVisible();
  await waitForSourceSessionToSettle(page);
  await mainComposer.fill('quote companion source two');
  await mainComposer.press('Enter');
  const secondSourceReply = page.getByText(/Fake backend received: quote companion source two/);
  await expect(secondSourceReply).toBeVisible();
  await waitForSourceSessionToSettle(page);
  const [sourceSession] = await page.evaluate(() => window.maka.sessions.list());
  expect(sourceSession).toBeDefined();

  // Create the same real DOM Range a drag selection would produce. Mutating
  // the selection fires `selectionchange` on its own, which is the hook's only
  // trigger; the click below absorbs the settle delay before the layer shows.
  const stageReply = async (reply: typeof firstSourceReply, expectedQuoteCount: number) => {
    await reply.evaluate((element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      document.dispatchEvent(
        new KeyboardEvent('keyup', { bubbles: true, key: 'Shift' }),
      );
    });
    await expect(page.getByRole('button', { name: '在侧栏追问' })).toBeVisible();
    await page.getByRole('button', { name: '在侧栏追问' }).click();
    await expect(
      page.locator('.maka-quote-companion .maka-composer-context-drawer .astryx-token'),
    ).toHaveCount(expectedQuoteCount);
    await expect(
      page
        .locator(
          '.maka-workbar-tab[data-active][data-workbar-tab-id^="side-chat:"]',
        )
        .getByRole('tab'),
    ).not.toHaveAttribute('aria-busy', 'true');
    await expect
      .poll(() =>
        page
          .locator('.maka-quote-workbar-panel:not([hidden])')
          .locator(COMPOSER_INPUT)
          .evaluate((element) => element === document.activeElement),
      )
      .toBe(true);
  };
  await stageReply(firstSourceReply, 1);
  await stageReply(secondSourceReply, 2);

  const panel = page.locator('.maka-quote-companion');
  await expect(panel).toBeVisible();
  await expect(panel.getByRole('button', { name: '关闭', exact: true })).toHaveCount(0);
  await expect(page.locator('[data-maka-contract="composer-inner"]')).toHaveCount(2);
  await expect(
    panel.getByRole('button', { name: '添加上下文', exact: true }),
  ).toBeVisible();
  await expect(panel.locator('.permissionModeIcon button').first()).toBeEnabled();

  // Quiet composer stages quotes as drawer Tokens (Astryx Token + remove).
  const quoteTokens = panel.locator('.maka-composer-context-drawer .astryx-token');
  const contextDrawerToggle = panel.locator(
    '.maka-composer-drawer [role="button"][aria-expanded]',
  );
  await expect(contextDrawerToggle).toHaveAttribute('aria-expanded', 'false');
  await expect(quoteTokens).toHaveCount(2);
  await contextDrawerToggle.click();
  await expect(quoteTokens).toHaveCount(2);
  await expect(quoteTokens.first()).toBeVisible();
  await expect(panel.locator('.maka-composer-model-status')).toHaveCount(0);
  await quoteTokens.first().getByRole('button', { name: /^移除/ }).click();
  await expect(quoteTokens).toHaveCount(1);

  // The empty transcript stays visually identical to an ordinary chat. Quote
  // context appears only in the shared Composer drawer, never duplicated as
  // explanatory content in the message area.
  await expect(panel.locator('.maka-turn')).toHaveCount(0);

  const companionComposer = panel.locator(COMPOSER_INPUT);
  await panel.locator('form.maka-composer').evaluate((form) => {
    const transfer = new DataTransfer();
    transfer.items.add(
      new File(['side attachment'], 'side-notes.txt', { type: 'text/plain' }),
    );
    form.dispatchEvent(
      new DragEvent('drop', {
        bubbles: true,
        cancelable: true,
        dataTransfer: transfer,
      }),
    );
  });
  const attachmentToken = panel.locator(
    '.maka-composer-context-drawer .astryx-token',
    { hasText: 'side-notes.txt' },
  );
  await expect(attachmentToken).toBeVisible();
  await companionComposer.fill('explain this quote');
  await companionComposer.press('Enter');
  const runningTab = page.locator(
    '.maka-workbar-tab[data-running][data-workbar-tab-id^="side-chat:"]',
  );
  await expect(runningTab).toBeVisible();
  await expect(runningTab.locator('.maka-workbar-tab-spinner')).toBeVisible();
  await expect(runningTab.locator('.maka-workbar-tab-close')).toBeVisible();
  await expect(panel.getByText(/Fake backend received: explain this quote/)).toBeVisible();
  await expect(panel.getByRole('button', { name: '重新生成' })).toBeVisible();
  await expect(panel.getByRole('button', { name: '复制' }).last()).toBeVisible();
  await expect(panel.getByRole('button', { name: '分支' })).toHaveCount(0);
  await expect(runningTab).toHaveCount(0);
  await expect(
    page.locator(
      '.maka-workbar-tab[data-workbar-tab-id^="side-chat:"] .maka-workbar-tab-icon:not(.maka-workbar-tab-spinner)',
    ),
  ).toBeVisible();
  await expect(quoteTokens).toHaveCount(0);
  await expect(attachmentToken).toHaveCount(0);

  await expect
    .poll(async () => (await page.evaluate(() => window.maka.sessions.list())).length)
    .toBe(2);
  const companionSession = (
    await page.evaluate(() => window.maka.sessions.list())
  ).find(({ id }) => id !== sourceSession?.id);
  expect(companionSession?.parentSessionId).toBe(sourceSession?.id);
  expect(companionSession?.permissionMode).toBe(sourceSession?.permissionMode);
  await expect(page.getByRole('tab', { name: 'explain this quote' })).toBeVisible();
  await page.getByRole('button', { name: '关闭explain this quote', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '关闭侧边对话？' })).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: '关闭侧边对话' }).click();
  await expect(panel).toBeHidden();
  await expect
    .poll(async () => (await page.evaluate(() => window.maka.sessions.list())).length)
    .toBe(1);
});

test('side chat persists steering and permission changes', async ({
  window: page,
}) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  const mainComposer = page.locator('.mainColumn').locator(COMPOSER_INPUT);
  await mainComposer.fill('side chat control source');
  await mainComposer.press('Enter');
  await expect(
    page.getByText(/Fake backend received: side chat control source/),
  ).toBeVisible();
  await waitForSourceSessionToSettle(page);
  const [sourceSession] = await page.evaluate(() => window.maka.sessions.list());
  expect(sourceSession).toBeDefined();

  // Steering and permission inheritance on a fresh fork.
  await openSideConversationFromLauncher(page);
  const steerPanel = page.locator('.maka-quote-workbar-panel:not([hidden])');
  const sideComposer = steerPanel.locator(COMPOSER_INPUT);
  await sideComposer.fill('__e2e_wait_for_steering__');
  await sideComposer.press('Enter');

  const sideUserMessages = steerPanel.locator('.maka-user-message');
  await expect(sideUserMessages).toHaveCount(1);
  await expect(sideUserMessages.first()).toContainText('__e2e_wait_for_steering__');
  await expect(steerPanel.getByRole('button', { name: '停止' })).toBeVisible();
  const steerButton = steerPanel.getByRole('button', { name: '插入消息' });
  await expect(steerButton).toBeVisible();
  await sideComposer.fill('only answer the side request');
  await expect(steerButton).toBeEnabled();
  await steerButton.click();
  await expect(sideComposer).toHaveText('');
  await expect(sideUserMessages).toHaveCount(2);
  await expect(sideUserMessages.first()).toContainText('__e2e_wait_for_steering__');
  await expect(sideUserMessages.nth(1)).toContainText('only answer the side request');
  await expect(
    steerPanel.getByText(/Acknowledged steering: only answer the side request/),
  ).toBeVisible();
  await expect(sideUserMessages).toHaveCount(2);
  await expect(sideUserMessages.first()).toContainText('__e2e_wait_for_steering__');
  await expect(sideUserMessages.nth(1)).toContainText('only answer the side request');

  const steerCompanion = (
    await page.evaluate(() => window.maka.sessions.list())
  ).find(({ id }) => id !== sourceSession?.id);
  expect(steerCompanion?.permissionMode).toBe(sourceSession?.permissionMode);
  const permissionButton = steerPanel.locator('.permissionModeIcon button').first();
  await expect(permissionButton).toBeEnabled();
  await permissionButton.click();
  await page.getByRole('menuitemradio', { name: /完全权限/ }).click();
  await expect
    .poll(async () => {
      const sessions = await page.evaluate(() => window.maka.sessions.list());
      return sessions.find(({ id }) => id === steerCompanion?.id)?.permissionMode;
    })
    .toBe('bypass');

  // The fork holds content, so closing it requires confirmation.
  await page
    .locator('.maka-workbar-tab[data-active][data-workbar-tab-id^="side-chat:"] .maka-workbar-tab-close')
    .click();
  await page.getByRole('dialog').getByRole('button', { name: '关闭侧边对话' }).click();
  await expect
    .poll(async () => (await page.evaluate(() => window.maka.sessions.list())).length)
    .toBe(1);
});

test('side chat recovers from failures and preserves its draft', async ({
  window: page,
}) => {
  test.slow();
  await page.setViewportSize({ width: 1400, height: 900 });
  const mainComposer = page.locator('.mainColumn').locator(COMPOSER_INPUT);
  await mainComposer.fill('side chat recovery source');
  await mainComposer.press('Enter');
  await expect(
    page.getByText(/Fake backend received: side chat recovery source/),
  ).toBeVisible();
  await waitForSourceSessionToSettle(page);

  // Failure classification, collapse survival, and retry.
  const rightPanel = page.locator('[data-maka-contract="session-workbar-right"]');
  await openSideConversationFromLauncher(page);
  const failPanel = page.locator('.maka-quote-companion');
  const failComposer = failPanel.locator(COMPOSER_INPUT);

  await failComposer.fill('__e2e_error__:network');
  await failComposer.press('Enter');
  await expect(failPanel.getByRole('button', { name: '停止' })).toBeVisible();

  await page.getByRole('button', { name: '收起会话工作栏' }).click();
  await expect(rightPanel).toBeHidden();
  await page.getByRole('button', { name: '展开会话工作栏' }).click();
  await expect(failPanel).toBeVisible();
  await expect(failPanel.locator('.maka-quote-companion-error')).toHaveText('网络错误');
  await expect(failPanel.getByRole('button', { name: '停止' })).toHaveCount(0);

  await failComposer.fill('retry after deterministic network failure');
  await failComposer.press('Enter');
  await expect(failPanel.locator('.maka-quote-companion-error')).toHaveCount(0);
  await expect(
    failPanel.getByText(/Fake backend received: retry after deterministic network failure/),
  ).toBeVisible();

  await failComposer.fill('__e2e_error__:auth');
  await failComposer.press('Enter');
  const activeSideTab = page.locator(
    '.maka-workbar-tab[data-running][data-workbar-tab-id^="side-chat:"]',
  );
  await expect(activeSideTab).toBeVisible();
  await activeSideTab.locator('.maka-workbar-tab-close').click();
  await expect(page.getByRole('dialog', { name: '关闭侧边对话？' })).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: '关闭侧边对话' }).click();
  await expect(failPanel).toBeHidden();
  await expect
    .poll(async () => (await page.evaluate(() => window.maka.sessions.list())).length)
    .toBe(1);
  await expect(page.getByText('鉴权失败')).toHaveCount(0);

  // Draft survival across collapse and launcher navigation.
  await waitForSourceSessionToSettle(page);

  await openSideConversationFromLauncher(page);
  const draftPanel = page.locator('.maka-quote-companion');
  const draftComposer = draftPanel.locator(COMPOSER_INPUT);
  await draftComposer.fill('draft survives panel navigation');

  await page.getByRole('button', { name: '收起会话工作栏' }).click();
  await expect(rightPanel).toBeHidden();
  await expect(draftPanel).toBeHidden();
  await page.getByRole('button', { name: '展开会话工作栏' }).click();
  await expect(rightPanel).toBeVisible();
  await expect(draftPanel).toBeVisible();
  await expect(draftComposer).toHaveText('draft survives panel navigation');

  await page.getByRole('button', { name: '打开工作栏工具' }).click();
  await expect(page.getByRole('menuitem', { name: /侧边对话/ })).toBeVisible();
  await expect(draftPanel).toBeHidden();
  await page.getByRole('tab', { name: '侧边对话', exact: true }).click();
  await expect(draftPanel).toBeVisible();
  await expect(draftComposer).toHaveText('draft survives panel navigation');

  await page.getByRole('button', { name: '关闭侧边对话', exact: true }).click();
  await expect(draftPanel).toBeHidden();
  await expect(rightPanel).toBeHidden();
  await expect
    .poll(async () => (await page.evaluate(() => window.maka.sessions.list())).length)
    .toBe(1);
});

// Standalone window: the batch close owes its confirmation dialog, and the
// numbered-tab journey above ends with 以后不再询问 checked, which would
// suppress exactly that dialog in a shared window.
test('batch tab close confirms once and cleans every non-empty side fork', async ({
  window: page,
}) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  const mainComposer = page.locator(COMPOSER_INPUT);
  await mainComposer.fill('batch side chat source');
  await mainComposer.press('Enter');
  await expect(page.getByText(/Fake backend received: batch side chat source/)).toBeVisible();
  await waitForSourceSessionToSettle(page);

  await page.getByRole('button', { name: '打开工作栏工具' }).click();
  await page.getByRole('menuitem', { name: '任务' }).click();

  await openSideConversationFromLauncher(page);
  let activePanel = page.locator('.maka-quote-workbar-panel:not([hidden])');
  await activePanel.locator(COMPOSER_INPUT).fill('first batch side chat');
  await activePanel.locator(COMPOSER_INPUT).press('Enter');
  await expect(activePanel.getByText(/Fake backend received: first batch side chat/)).toBeVisible();

  await openSideConversationFromLauncher(page);
  activePanel = page.locator('.maka-quote-workbar-panel:not([hidden])');
  await activePanel.locator(COMPOSER_INPUT).fill('second batch side chat');
  await activePanel.locator(COMPOSER_INPUT).press('Enter');
  await expect(activePanel.getByText(/Fake backend received: second batch side chat/)).toBeVisible();
  await expect
    .poll(async () => (await page.evaluate(() => window.maka.sessions.list())).length)
    .toBe(3);

  await page.getByRole('tab', { name: /^任务/ }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: '关闭其他标签' }).click();
  await expect(page.getByRole('dialog', { name: '关闭 2 个侧边对话？' })).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: '关闭侧边对话' }).click();

  await expect(page.getByRole('tab', { name: /^任务/ })).toBeVisible();
  await expect(page.locator('[data-workbar-tab-id^="side-chat:"]')).toHaveCount(0);
  await expect
    .poll(async () => (await page.evaluate(() => window.maka.sessions.list())).length)
    .toBe(1);
});
