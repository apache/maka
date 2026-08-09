import type { Locator, Page } from '@playwright/test';
import { expect, test } from './fixtures';

async function takeScrollControl(page: Page, header: Locator): Promise<void> {
  await header.evaluate((element) => {
    const scroller = element.closest<HTMLElement>('[data-chat-scroll-container="true"]');
    if (!scroller) throw new Error('Chat scroll container not found');
    scroller.scrollTop +=
      element.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 120;
  });
  const scrollport = await page.locator('[data-chat-scroll-container="true"]').boundingBox();
  if (!scrollport) throw new Error('Chat scroll container is not visible');
  await page.mouse.move(scrollport.x + scrollport.width / 3, scrollport.y + scrollport.height / 2);
  await page.mouse.wheel(0, -24);
}

async function scrollHeaderPastTop(header: Locator, distance = 96): Promise<void> {
  await header.evaluate((element, scrollDistance) => {
    const scroller = element.closest<HTMLElement>('[data-chat-scroll-container="true"]');
    if (!scroller) throw new Error('Chat scroll container not found');
    scroller.scrollTop +=
      element.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scrollDistance;
  }, distance);
}

async function headerOffset(header: Locator): Promise<number> {
  return header.evaluate((element) => {
    const scroller = element.closest<HTMLElement>('[data-chat-scroll-container="true"]');
    if (!scroller) throw new Error('Chat scroll container not found');
    return element.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
  });
}

async function backgroundAlpha(element: Locator): Promise<number> {
  return element.evaluate((target) => {
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas context not available');
    context.clearRect(0, 0, 1, 1);
    context.fillStyle = getComputedStyle(target).backgroundColor;
    context.fillRect(0, 0, 1, 1);
    return context.getImageData(0, 0, 1, 1).data[3];
  });
}

test('expanded activity headers stay reachable while their long details scroll', async ({
  activityCardWindow: page,
}) => {
  await page.setViewportSize({ width: 1000, height: 520 });

  const reasoning = page.locator('.maka-deep-thinking').first();
  const reasoningHeader = reasoning.locator('[data-slot="activity-card-header"]');
  await takeScrollControl(page, reasoningHeader);
  await reasoningHeader.click();
  await reasoning.locator('.maka-chat-reasoning-content').evaluate((element) => {
    element.style.minHeight = '720px';
  });
  await expect.poll(() => reasoning.evaluate((element) => element.getBoundingClientRect().height))
    .toBeGreaterThan(700);
  await scrollHeaderPastTop(reasoningHeader);

  await expect.poll(() => headerOffset(reasoningHeader)).toBeCloseTo(8, 0);
  await reasoningHeader.hover();
  await expect.poll(() => backgroundAlpha(reasoningHeader)).toBe(255);
  await reasoningHeader.click();
  await expect(reasoningHeader).toHaveAttribute('aria-expanded', 'false');

  const toolGroup = page.locator('.maka-tool-activity-card').filter({
    has: page.locator(':scope > [role="button"]'),
  }).first();
  const groupHeader = toolGroup.locator(':scope > [role="button"]');
  await groupHeader.click();

  // Stock ChatToolCalls marks expandable call rows with role=button only —
  // data-slot="chat-tool-call-row" was a removed Astryx patch (#2574). Nested
  // rows live under the group content; the group header is the direct child.
  const callHeader = toolGroup.locator(':scope [role="button"]').nth(1);
  await callHeader.click();
  await toolGroup.locator('.maka-chat-tool-detail-inner').first().evaluate((element) => {
    element.style.minHeight = '720px';
  });
  await expect.poll(() => toolGroup.evaluate((element) => element.getBoundingClientRect().height))
    .toBeGreaterThan(700);
  await scrollHeaderPastTop(callHeader);

  await expect.poll(() => headerOffset(groupHeader)).toBeCloseTo(8, 0);
  await expect.poll(() => headerOffset(callHeader)).toBeCloseTo(32, 0);
  await callHeader.click();
  await expect(callHeader).toHaveAttribute('aria-expanded', 'false');

  await page.locator('.maka-chat-message-list').evaluate((element) => {
    element.style.paddingBottom = '720px';
  });
  await expect.poll(() => toolGroup.evaluate((element) => element.getBoundingClientRect().height))
    .toBeLessThan(240);
  await toolGroup.evaluate((element) => {
    const scroller = element.closest<HTMLElement>('[data-chat-scroll-container="true"]');
    if (!scroller) throw new Error('Chat scroll container not found');
    scroller.scrollTop +=
      element.getBoundingClientRect().bottom - scroller.getBoundingClientRect().top + 96;
  });
  await expect.poll(() => headerOffset(groupHeader)).toBeLessThan(0);
});
