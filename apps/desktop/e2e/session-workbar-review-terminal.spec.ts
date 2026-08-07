import { test, expect, COMPOSER_INPUT } from './fixtures';

async function openTool(page: import('@playwright/test').Page, name: string) {
  await page.getByRole('button', { name: '打开工作栏工具' }).click();
  await page.getByRole('menuitem', { name }).click();
}

test('Review reuses persisted file-diff tool results', async ({
  sessionWorkbarWindow: page,
}) => {
  await page.setViewportSize({ width: 1400, height: 900 });

  await openTool(page, '审阅');
  const review = page.locator('.maka-session-review-panel');
  await expect(review).toBeVisible();
  await expect(
    review.getByText(
      'apps/desktop/src/renderer/settings/provider-connection-detail.tsx',
    ),
  ).toBeVisible();
  await expect(review.getByText('+function EnabledModelManager(props) {')).toBeVisible();
  await expect(review.getByRole('radio', { name: '上一轮' })).toBeChecked();
  await review.getByRole('radio', { name: '已暂存' }).click();
  await expect(review.getByText('当前会话目录已不可用')).toBeVisible();
  await review.getByRole('radio', { name: '上一轮' }).click();
  await expect(review.getByText('+function EnabledModelManager(props) {')).toBeVisible();
});

test('Review switches between branch, unstaged, and staged Git snapshots', async ({
  gitReviewWindow: page,
}) => {
  const composer = page.locator(COMPOSER_INPUT);
  await composer.fill('git review source');
  await page.getByRole('button', { name: '发送' }).click();
  await expect(page.getByText(/Fake backend received: git review source/)).toBeVisible();

  await openTool(page, '审阅');
  const review = page.locator('.maka-session-review-panel');
  await expect(review.getByRole('radio', { name: '分支' })).toBeChecked();
  await expect(review.getByText('feature/review 相对 main')).toBeVisible();
  await expect(review.getByText('feature.txt', { exact: true })).toBeVisible();
  await expect(review.getByText('staged.txt', { exact: true })).toBeVisible();
  await expect(review.getByText('untracked.txt', { exact: true })).toBeVisible();
  await review
    .getByRole('button', { name: 'feature/review 相对 main' })
    .click();
  await page.getByRole('menuitem', { name: 'feature/review' }).click();
  await expect(
    review.getByRole('button', {
      name: 'feature/review 工作区',
    }),
  ).toBeVisible();
  await expect(review.getByText('feature.txt', { exact: true })).toHaveCount(0);

  await review.getByRole('radio', { name: '未暂存' }).click();
  await expect(review.getByText('base.txt', { exact: true })).toBeVisible();
  await expect(review.getByText('untracked.txt', { exact: true })).toBeVisible();
  await expect(review.getByText('staged.txt', { exact: true })).toHaveCount(0);
  await review
    .locator('[data-kind="file_diff"]')
    .filter({ hasText: 'untracked.txt' })
    .getByRole('button', { name: '还原文件' })
    .click();
  await expect(
    page.getByRole('heading', { name: '还原未暂存变化？' }),
  ).toBeVisible();
  await page.getByRole('button', { name: '确认还原' }).click();
  await expect(review.getByText('untracked.txt', { exact: true })).toHaveCount(0);
  await review
    .locator('[data-kind="file_diff"]')
    .filter({ hasText: 'base.txt' })
    .getByRole('button', { name: '暂存文件' })
    .click();
  await expect(review.getByText('base.txt', { exact: true })).toHaveCount(0);

  await review.getByRole('radio', { name: '已暂存' }).click();
  await expect(review.getByText('base.txt', { exact: true })).toBeVisible();
  await expect(review.getByText('staged.txt', { exact: true })).toBeVisible();
  await expect(review.getByText('untracked.txt', { exact: true })).toHaveCount(0);
  await review
    .locator('[data-kind="file_diff"]')
    .filter({ hasText: 'staged.txt' })
    .getByRole('button', { name: '取消暂存文件' })
    .click();
  await expect(review.getByText('staged.txt', { exact: true })).toHaveCount(0);
  await review.getByRole('radio', { name: '未暂存' }).click();
  await expect(review.getByText('staged.txt', { exact: true })).toBeVisible();
});

test('Review progressively mounts large file lists in Codex-sized pages', async ({
  gitReviewLargeWindow: page,
}) => {
  const composer = page.locator(COMPOSER_INPUT);
  await composer.fill('large git review source');
  await page.getByRole('button', { name: '发送' }).click();
  await expect(page.getByText(/Fake backend received: large git review source/)).toBeVisible();

  await openTool(page, '审阅');
  const review = page.locator('.maka-session-review-panel');
  await expect(review.locator('[data-kind="file_diff"]')).toHaveCount(20);
  await review.getByRole('button', { name: '再显示 20 个文件' }).click();
  await expect(review.locator('[data-kind="file_diff"]')).toHaveCount(40);
});

test('Review and Terminal shortcuts open the Codex-matching tabs', async ({
  window: page,
}) => {
  const composer = page.locator(COMPOSER_INPUT);
  await composer.fill('terminal shortcut source');
  await page.getByRole('button', { name: '发送' }).click();
  await expect(page.getByText(/Fake backend received: terminal shortcut source/)).toBeVisible();

  await page.keyboard.press('Control+Shift+G');
  await expect(page.getByRole('tab', { name: '审阅' })).toBeVisible();
  await page.keyboard.press('Control+Backquote');
  await expect(page.getByRole('tab', { name: '终端', exact: true })).toBeVisible();
  await openTool(page, '终端');
  await expect(page.getByRole('tab', { name: '终端 2', exact: true })).toBeVisible();
  await expect(page.locator('[data-maka-contract="session-terminal-xterm"]')).toHaveCount(2);
});

test('Terminal starts a real PTY, accepts commands, and stops it', async ({
  window: page,
}) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  const composer = page.locator(COMPOSER_INPUT);
  await composer.fill('interactive terminal source');
  await page.getByRole('button', { name: '发送' }).click();
  await expect(page.getByText(/Fake backend received: interactive terminal source/)).toBeVisible();

  await openTool(page, '终端');
  const terminal = page.locator('.maka-session-terminal-panel');
  await expect(terminal.locator('.xterm-screen')).toBeVisible();
  const liveTerminal = await terminal.evaluate(async (element) => {
    const ref = element.getAttribute('data-terminal-ref');
    if (!ref) return null;
    for (const session of await window.maka.sessions.list()) {
      const run = (await window.maka.shellRuns.list(session.id)).find(
        (candidate) => candidate.result.ref === ref,
      );
      if (!run) continue;
      return {
        sessionId: session.id,
        status: run.result.status,
        snapshot: await window.maka.shellRuns.attach({
          sessionId: session.id,
          ref,
        }),
      };
    }
    return { ref, sessionId: null, status: null, snapshot: null };
  });
  expect(liveTerminal?.snapshot).not.toBeNull();
  if (!liveTerminal?.sessionId || !liveTerminal.snapshot) {
    throw new Error('Terminal tab did not bind to a live PTY session');
  }
  const liveIdentity = {
    sessionId: liveTerminal.sessionId,
    ref: liveTerminal.snapshot.ref,
  };
  await terminal.locator('.xterm-screen').click();
  await page.keyboard.type("printf 'maka-interactive-terminal-ok\\n'");
  await page.keyboard.press('Enter');
  await expect(
    terminal.getByText('maka-interactive-terminal-ok', { exact: true }),
  ).toBeVisible({
    timeout: 15_000,
  });

  const rightPanel = page.locator('[data-maka-contract="session-workbar-right"]');
  await rightPanel.getByRole('tab', { name: '终端' }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: '移动到底部面板' }).click();
  const bottomPanel = page.locator('[data-maka-contract="session-workbar-bottom"]');
  await expect(bottomPanel.getByRole('tab', { name: '终端' })).toBeVisible();
  await expect(
    page
      .locator('.maka-session-workbar-panel[data-placement="bottom"]')
      .locator('.xterm-screen'),
  ).toBeVisible();
  await expect(
    page
      .locator('.maka-session-workbar-panel[data-placement="bottom"]')
      .getByRole('listitem')
      .filter({ hasText: /^maka-interactive-terminal-ok$/ }),
  ).toBeVisible();

  await page.getByRole('button', { name: '关闭终端' }).click();
  await expect(page.getByRole('tab', { name: '终端' })).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(
        (identity) => window.maka.shellRuns.attach(identity),
        liveIdentity,
      ),
    )
    .toBeNull();
});
