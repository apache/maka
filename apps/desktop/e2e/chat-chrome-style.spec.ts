import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';

type Platform = 'darwin' | 'win32';

interface ShellFacts {
  viewport: { width: number; height: number };
  shell: DOMRectFacts;
  titlebar: DOMRectFacts;
  sidebar: DOMRectFacts;
  detail: DOMRectFacts;
  backgrounds: {
    shellImage: string;
    sidebarImage: string;
    detailImage: string;
  };
  effects: {
    shellShadow: string;
    sidebarShadow: string;
    detailShadow: string;
    shellFilter: string;
    sidebarFilter: string;
    detailFilter: string;
  };
  opacity: {
    shell: number;
    sidebar: number;
    detail: number;
  };
}

interface DOMRectFacts {
  top: number;
  right: number;
  bottom: number;
  left: number;
  width: number;
  height: number;
}

function closeTo(actual: number, expected: number, message: string): void {
  expect(Math.abs(actual - expected), `${message}: actual=${actual}, expected=${expected}`).toBeLessThanOrEqual(1);
}

async function prepareWindow(page: Page, platform: Platform): Promise<void> {
  await expect(page.locator('html')).toHaveAttribute('data-os', platform);
  const shell = page.locator('.maka-shell-astryx');
  if ((await shell.getAttribute('data-sidebar-state')) === 'collapsed') {
    await page.getByRole('button', { name: '展开侧边栏' }).click();
  }
  await expect(shell).toHaveAttribute('data-sidebar-state', 'expanded');
}

async function readShellFacts(page: Page): Promise<ShellFacts> {
  return page.evaluate(() => {
    const shell = document.querySelector<HTMLElement>('.maka-shell-astryx');
    const titlebar = document.querySelector<HTMLElement>('.maka-window-titlebar');
    const sidebar = document.querySelector<HTMLElement>('.maka-session-panel');
    const detail = document.querySelector<HTMLElement>('.maka-panel-detail');
    if (!shell || !titlebar || !sidebar || !detail) {
      throw new Error('official shell surface disappeared mid-read');
    }

    const rect = (element: HTMLElement): DOMRectFacts => {
      const value = element.getBoundingClientRect();
      return {
        top: value.top,
        right: value.right,
        bottom: value.bottom,
        left: value.left,
        width: value.width,
        height: value.height,
      };
    };
    const shellStyle = getComputedStyle(shell);
    const sidebarStyle = getComputedStyle(sidebar);
    const detailStyle = getComputedStyle(detail);

    return {
      viewport: { width: innerWidth, height: innerHeight },
      shell: rect(shell),
      titlebar: rect(titlebar),
      sidebar: rect(sidebar),
      detail: rect(detail),
      backgrounds: {
        shellImage: shellStyle.backgroundImage,
        sidebarImage: sidebarStyle.backgroundImage,
        detailImage: detailStyle.backgroundImage,
      },
      effects: {
        shellShadow: shellStyle.boxShadow,
        sidebarShadow: sidebarStyle.boxShadow,
        detailShadow: detailStyle.boxShadow,
        shellFilter: shellStyle.filter,
        sidebarFilter: sidebarStyle.filter,
        detailFilter: detailStyle.filter,
      },
      opacity: {
        shell: Number(shellStyle.opacity),
        sidebar: Number(sidebarStyle.opacity),
        detail: Number(detailStyle.opacity),
      },
    };
  });
}

function assertOfficialShell(facts: ShellFacts, tag: string): void {
  closeTo(facts.shell.left, 0, `${tag} shell left`);
  closeTo(facts.shell.top, 0, `${tag} shell top`);
  closeTo(facts.shell.right, facts.viewport.width, `${tag} shell right`);
  closeTo(facts.shell.bottom, facts.viewport.height, `${tag} shell bottom`);

  closeTo(facts.sidebar.top, facts.titlebar.bottom, `${tag} sidebar starts below titlebar`);
  closeTo(facts.detail.top, facts.titlebar.bottom, `${tag} detail starts below titlebar`);
  closeTo(facts.sidebar.right, facts.detail.left, `${tag} sidebar and detail share one edge`);
  closeTo(facts.detail.right, facts.viewport.width, `${tag} detail right`);
  for (const [surface, bottom] of Object.entries({
    sidebar: facts.sidebar.bottom,
    detail: facts.detail.bottom,
  })) {
    const platformBottomInset = facts.viewport.height - bottom;
    expect(platformBottomInset, `${tag} ${surface} must not overflow the viewport`).toBeGreaterThanOrEqual(0);
    expect(platformBottomInset, `${tag} ${surface} must not leave a product-sized bottom gutter`).toBeLessThanOrEqual(12);
  }
  expect(facts.sidebar.width, `${tag} official SideNav width`).toBeGreaterThanOrEqual(180);
  expect(facts.detail.width, `${tag} detail must retain usable width`).toBeGreaterThan(0);

  for (const [surface, image] of Object.entries(facts.backgrounds)) {
    expect(image, `${tag} ${surface} must not add a custom gradient/image`).toBe('none');
  }
  for (const [surface, shadow] of Object.entries({
    shell: facts.effects.shellShadow,
    sidebar: facts.effects.sidebarShadow,
    detail: facts.effects.detailShadow,
  })) {
    expect(shadow, `${tag} ${surface} must stay flat`).toBe('none');
  }
  for (const [surface, filter] of Object.entries({
    shell: facts.effects.shellFilter,
    sidebar: facts.effects.sidebarFilter,
    detail: facts.effects.detailFilter,
  })) {
    expect(filter, `${tag} ${surface} must not add filter effects`).toBe('none');
  }
  for (const [surface, opacity] of Object.entries(facts.opacity)) {
    expect(opacity, `${tag} ${surface} must remain fully visible`).toBe(1);
  }
}

test('chat chrome follows the official flat AppShell across platform and theme combos', async ({
  chatChromeDarwinWindow,
  chatChromeWin32Window,
}) => {
  const windows: Array<{ platform: Platform; page: Page }> = [
    { platform: 'darwin', page: chatChromeDarwinWindow },
    { platform: 'win32', page: chatChromeWin32Window },
  ];

  for (const { platform, page } of windows) {
    await prepareWindow(page, platform);
    for (const dark of [false, true]) {
      await page.emulateMedia({ colorScheme: dark ? 'dark' : 'light' });
      const html = page.locator('html');
      if (dark) {
        await expect(html).toHaveClass(/(?:^| )dark(?:$| )/);
      } else {
        await expect(html).not.toHaveClass(/(?:^| )dark(?:$| )/);
      }
      assertOfficialShell(await readShellFacts(page), `${platform}/${dark ? 'dark' : 'light'}`);
    }
  }
});
