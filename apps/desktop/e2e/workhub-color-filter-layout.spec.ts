import { expect, test } from '@playwright/test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const e2eDir = dirname(fileURLToPath(import.meta.url));

test('message color filters stay centered just outside both message edges', async ({ page }) => {
  await page.setContent(`
    <div id="user" class="workhub-message workhub-work-message" data-sender="user">
      <div class="chat-message-inner">
        <button class="workhub-work-color-filter workhub-work-color-filter-user"></button>
        <div class="maka-chat-message-bubble-user">User</div>
      </div>
    </div>
    <div id="assistant" class="workhub-message workhub-work-message" data-sender="assistant">
      <div class="chat-message-inner">
        <button class="workhub-work-color-filter workhub-work-color-filter-assistant"></button>
        <div class="maka-chat-message-bubble-assistant">Assistant</div>
      </div>
    </div>
  `);
  await page.addStyleTag({ path: resolve(e2eDir, '../src/renderer/maka-tokens.css') });
  await page.addStyleTag({ path: resolve(e2eDir, '../src/renderer/styles/workhub.css') });
  await page.addStyleTag({ content: `
    #user, #assistant { width: 680px; height: 80px; margin: 32px; }
  ` });

  const geometry = await page.evaluate(() => {
    const measure = (messageId: string) => {
      const message = document.querySelector<HTMLElement>(`#${messageId}`)!;
      const filter = message.querySelector<HTMLElement>('.workhub-work-color-filter')!;
      const messageRect = message.getBoundingClientRect();
      const filterRect = filter.getBoundingClientRect();
      return {
        center: filterRect.left + filterRect.width / 2,
        left: messageRect.left,
        right: messageRect.right,
      };
    };
    return { user: measure('user'), assistant: measure('assistant') };
  });

  expect(geometry.user.center - geometry.user.right).toBeCloseTo(6, 0);
  expect(geometry.assistant.center - geometry.assistant.left).toBeCloseTo(-6, 0);
});

test('WorkHub anchor rail reveals one Work color across its grouped ticks', async ({ page }) => {
  await page.setContent(`
    <nav class="maka-prompt-rail">
      <button
        id="first"
        class="maka-prompt-rail-tick"
        data-has-accent="true"
        data-group-highlighted="true"
        style="--maka-prompt-rail-accent:#b91c1c"
      >
        <span class="maka-prompt-rail-tick-bar"></span>
      </button>
      <button
        id="same-work"
        class="maka-prompt-rail-tick"
        data-has-accent="true"
        data-group-highlighted="true"
        style="--maka-prompt-rail-accent:#b91c1c"
      ><span class="maka-prompt-rail-tick-bar"></span></button>
      <button
        id="other-work"
        class="maka-prompt-rail-tick"
        data-has-accent="true"
        style="--maka-prompt-rail-accent:#2563eb"
      ><span class="maka-prompt-rail-tick-bar"></span></button>
    </nav>
    <span class="maka-prompt-rail-preview" style="--maka-prompt-rail-accent:#b91c1c">
      <span class="maka-prompt-rail-preview-context">登录稳定性</span>
      <span class="maka-prompt-rail-preview-prompt">排查登录超时</span>
    </span>
  `);
  await page.addStyleTag({ path: resolve(e2eDir, '../src/renderer/maka-tokens.css') });
  await page.addStyleTag({ path: resolve(e2eDir, '../src/renderer/styles/prompt-rail.css') });

  const tick = page.locator('#first');
  const before = await tick.evaluate((element) => getComputedStyle(element).color);
  await tick.hover();
  await expect(tick).toHaveCSS('color', 'rgb(185, 28, 28)');
  await expect(page.locator('#same-work')).toHaveCSS('color', 'rgb(185, 28, 28)');
  await expect(page.locator('#other-work')).not.toHaveCSS('color', 'rgb(185, 28, 28)');
  await expect(page.locator('.maka-prompt-rail-preview-context'))
    .toHaveCSS('color', 'rgb(185, 28, 28)');
  expect(before).not.toBe('rgb(185, 28, 28)');
});

test('WorkHub question choices make selection and motion unmistakable', async ({ page }) => {
  await page.setContent(`
    <div class="workhub-interaction-card" style="--workhub-accent:#b91c1c">
      <fieldset>
        <legend>支付回调的真实代码在哪里？</legend>
        <div class="workhub-question-options">
          <button id="selected" type="button" data-selected="true">
            <span>在其它仓库/路径</span>
            <small>请给出绝对路径</small>
          </button>
          <button id="idle" type="button">
            <span>还没实现，先做设计评审</span>
            <small>基于风险清单继续</small>
          </button>
        </div>
      </fieldset>
    </div>
  `);
  await page.addStyleTag({ path: resolve(e2eDir, '../src/renderer/maka-tokens.css') });
  await page.addStyleTag({ path: resolve(e2eDir, '../src/renderer/styles/workhub.css') });
  await page.addStyleTag({ content: `
    :root {
      --color-background-surface: #fff;
      --color-background-subtle: #f6f6f6;
      --color-border-subtle: #ddd;
      --color-border-emphasized: #999;
      --color-text-primary: #111;
      --color-text-secondary: #555;
    }
  ` });

  const selected = page.locator('#selected');
  const idle = page.locator('#idle');
  const selectedBackground = await selected.evaluate((element) => getComputedStyle(element).backgroundColor);
  const idleBackground = await idle.evaluate((element) => getComputedStyle(element).backgroundColor);
  const indicator = await selected.evaluate((element) => {
    const style = getComputedStyle(element, '::before');
    return { content: style.content, opacity: style.opacity, transform: style.transform };
  });

  expect(selectedBackground).not.toBe(idleBackground);
  expect(indicator.content).not.toBe('none');
  expect(indicator.opacity).toBe('1');
  expect(indicator.transform).not.toBe('matrix(0, 0, 0, 0, 0, 0)');
  await expect(selected).not.toHaveCSS('transition-duration', '0s');

  await page.emulateMedia({ reducedMotion: 'reduce' });
  const reducedDuration = await selected.evaluate((element) =>
    Number.parseFloat(getComputedStyle(element).transitionDuration),
  );
  expect(reducedDuration).toBeLessThanOrEqual(0.01);
});
