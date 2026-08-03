import { test, expect, COMPOSER_INPUT } from './fixtures';
import { FAKE_MERMAID_HOSTILE_PROMPT, FAKE_MERMAID_PROMPT } from '@maka/runtime';

/**
 * Core chat loop: type a message, send it, see the deterministic fake backend
 * stream a reply back into the transcript. Depends on the E2E seam: the
 * fixture's MAKA_E2E=1 forces sessions:create onto the fake backend, and the
 * seeded 'e2e' connection clears onboarding so the composer is usable.
 */
test('send a message and see the fake backend stream a reply', async ({ window: page }) => {
  const composer = page.locator(COMPOSER_INPUT);
  // #1433: the deleted first-run panel had its own input, and the spec that
  // covered the handoff between the two asserted this accessible name. With
  // one composer left, the name is what a screen-reader user has to find the
  // send target by — assert it on the path that exercises it.
  await expect(composer).toHaveAttribute('aria-label', '消息输入框');
  await composer.fill('hello e2e');
  await composer.press('Enter');

  await expect(page.getByText(/Fake backend received: hello e2e/)).toBeVisible();
});

/**
 * Enter commits a candidate in a CJK IME; nothing else may act on it. Both the
 * composer's send and ChatComposerInput's trigger menu read Enter, and the
 * component runs its menu handling before the `onKeyDown` we pass it — so the
 * guard is a native capture on the composer root that takes the key away from
 * React entirely.
 */
test('Enter mid-IME-composition commits the candidate instead of sending', async ({
  window: page,
}) => {
  const composer = page.locator(COMPOSER_INPUT);
  await composer.fill('中文草稿');
  await composer.evaluate((element) => {
    element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    // `isComposing: false` on purpose: only the composition we track ourselves
    // can stop this one, so a passing test can't be crediting the component's
    // own `nativeEvent.isComposing` check.
    element.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    );
    element.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
  });

  // A leaked send is asynchronous, so `toHaveCount(0)` can pass before it
  // lands, and a second send of the same text would hide it. Send something
  // different and pin the total instead.
  await composer.fill('中文草稿 已提交');
  await composer.press('Enter');
  await expect(page.getByText(/Fake backend received: 中文草稿 已提交/)).toBeVisible();
  await expect(page.getByLabel('你发送的消息')).toHaveCount(1);
});

test('renders a settled Mermaid fence as a diagram', async ({ window: page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const composer = page.locator(COMPOSER_INPUT);
  await composer.fill(FAKE_MERMAID_PROMPT);
  await composer.press('Enter');

  await expect(page.getByRole('button', { name: '重新生成' })).toBeVisible();
  await expect(page.locator('.maka-bubble-streaming')).toHaveCount(0);
  const diagram = page.locator('[data-maka-contract="mermaid"]').last();
  await expect(diagram).toHaveAttribute('data-maka-mermaid-state', 'rendered');
  await expect(diagram).toHaveAttribute('data-maka-mermaid-layout', 'ready');
  await expect(diagram.locator('.maka-mermaid-svg > svg')).toBeVisible();
  await expect(diagram.locator('script, foreignObject, a')).toHaveCount(0);
  await expect(diagram.locator('.cluster')).toHaveCount(3);

  const viewport = diagram.locator('.maka-mermaid-viewport');
  const fitted = await viewport.evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
  }));
  expect(fitted.scrollWidth).toBeLessThanOrEqual(fitted.clientWidth + 1);
  expect(fitted.scrollHeight).toBeLessThanOrEqual(fitted.clientHeight + 1);
  await expect(viewport).toHaveCSS('touch-action', 'pan-y');

  const viewSource = diagram.getByRole('button', { name: '查看 Mermaid 源码' });
  await viewSource.click();
  await expect(diagram.locator('.maka-mermaid-source')).toContainText('flowchart TB');
  await viewSource.click();

  // Zoom moves the diagram's content, never its chrome. Read the toolbar
  // offset and the viewport height inside one evaluate: the transcript is a
  // bottom-pinned scroller that re-pins on every ResizeObserver update, so two
  // separate boundingBox() round-trips sample the same element at two scroll
  // positions and turn that drift into a phantom offset change (#2000).
  const readChrome = () => diagram.evaluate((element) => {
    const diagramTop = element.getBoundingClientRect().top;
    const toolbarTop = element.querySelector('.maka-mermaid-toolbar')?.getBoundingClientRect().top;
    const viewportHeight = element.querySelector('.maka-mermaid-viewport')?.getBoundingClientRect().height;
    return { toolbarOffset: (toolbarTop ?? 0) - diagramTop, viewportHeight: viewportHeight ?? 0 };
  });
  const chromeBeforeZoom = await readChrome();
  const zoomIn = diagram.getByRole('button', { name: '放大图表' });
  await zoomIn.click();
  await expect(diagram).toHaveAttribute('data-maka-mermaid-zoom', '1.25');
  await zoomIn.click();
  await expect(diagram).toHaveAttribute('data-maka-mermaid-zoom', '1.50');
  // Poll for the steady state: the zoomed layout settles over a rAF, a
  // ResizeObserver pass, and the scroller's re-pin, so a single instantaneous
  // read asserts a frame the user never sees.
  await expect.poll(async () => {
    const chrome = await readChrome();
    return Math.max(
      Math.abs(chrome.toolbarOffset - chromeBeforeZoom.toolbarOffset),
      Math.abs(chrome.viewportHeight - chromeBeforeZoom.viewportHeight),
    );
  }).toBeLessThanOrEqual(1);
  await expect.poll(() => viewport.evaluate((element) =>
    element.scrollWidth > element.clientWidth || element.scrollHeight > element.clientHeight)).toBe(true);
  const zoomedBounds = await diagram.evaluate((element) => {
    const svg = element.querySelector('.maka-mermaid-svg > svg');
    const content = svg?.querySelector('g');
    const svgRect = svg?.getBoundingClientRect();
    const contentRect = content?.getBoundingClientRect();
    return {
      svg: svgRect
        ? { top: svgRect.top, bottom: svgRect.bottom, width: svgRect.width, height: svgRect.height }
        : null,
      content: contentRect
        ? { top: contentRect.top, bottom: contentRect.bottom }
        : null,
    };
  });
  expect(zoomedBounds.svg).not.toBeNull();
  expect(zoomedBounds.content).not.toBeNull();
  expect(zoomedBounds.content?.top ?? 0).toBeGreaterThanOrEqual((zoomedBounds.svg?.top ?? 0) - 1);
  expect(zoomedBounds.content?.bottom ?? 0).toBeLessThanOrEqual((zoomedBounds.svg?.bottom ?? 0) + 1);
  await diagram.getByRole('button', { name: '适应视窗' }).click();
  await expect(diagram).toHaveAttribute('data-maka-mermaid-zoom', '1.00');
  const inlineSvg = diagram.locator('.maka-mermaid-svg > svg');
  await expect(inlineSvg).toBeVisible();
  await expect.poll(async () => {
    const bounds = await inlineSvg.boundingBox();
    return bounds ? bounds.width * bounds.height : 0;
  }).toBeGreaterThan(0);
  const inlineSvgBounds = await inlineSvg.boundingBox();
  expect(inlineSvgBounds).not.toBeNull();

  await diagram.getByRole('button', { name: '全屏查看图表' }).click();
  const modal = page.locator('dialog.maka-mermaid-dialog');
  await expect(modal).toHaveAttribute('open', '');
  await expect(modal).toHaveAttribute('aria-modal', 'true');
  const expandedDiagram = modal.locator('[data-maka-contract="mermaid"]');
  const pageSize = page.viewportSize();
  await expect.poll(async () => {
    const bounds = await modal.boundingBox();
    return bounds && pageSize
      ? Math.max(
          Math.abs(bounds.x),
          Math.abs(bounds.y),
          Math.abs(bounds.width - pageSize.width),
          Math.abs(bounds.height - pageSize.height),
        )
      : Number.POSITIVE_INFINITY;
  }).toBeLessThanOrEqual(1);
  await expect.poll(async () => {
    const bounds = await expandedDiagram.locator('.maka-mermaid-svg > svg').boundingBox();
    return bounds ? bounds.width * bounds.height : 0;
  }).toBeGreaterThan((inlineSvgBounds?.width ?? 0) * (inlineSvgBounds?.height ?? 0) * 1.5);
  await expect.poll(() => expandedDiagram.locator('.maka-mermaid-actions').evaluate((element) =>
    getComputedStyle(element).getPropertyValue('-webkit-app-region'))).toBe('no-drag');
  const exitFullscreen = expandedDiagram.getByRole('button', { name: '退出全屏图表' });
  await expect(exitFullscreen).toBeFocused();
  await page.keyboard.press('Tab');
  await expect.poll(() => modal.evaluate((element) => element.contains(document.activeElement))).toBe(true);
  await exitFullscreen.click();
  await expect(modal).not.toHaveAttribute('open', '');
  const enterFullscreen = diagram.getByRole('button', { name: '全屏查看图表' });
  await expect(enterFullscreen).toBeFocused();

  await enterFullscreen.click();
  await expect(expandedDiagram.getByRole('button', { name: '退出全屏图表' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(diagram.getByRole('button', { name: '全屏查看图表' })).toBeFocused();

  await page.setViewportSize({ width: 340, height: 900 });
  await expect(diagram.getByRole('button', { name: '全屏查看图表' })).toBeVisible();
  await expect(diagram.getByRole('button', { name: '放大图表' })).toBeHidden();
});

test('keeps hostile Mermaid directives inert', async ({ window: page }) => {
  const composer = page.locator(COMPOSER_INPUT);
  await composer.fill(FAKE_MERMAID_HOSTILE_PROMPT);
  await composer.press('Enter');

  await expect(page.getByRole('button', { name: '重新生成' })).toBeVisible();
  const diagram = page.locator('[data-maka-contract="mermaid"]').last();
  await expect(diagram).toHaveAttribute('data-maka-mermaid-state', 'rendered');
  await expect(diagram.locator('.maka-mermaid-svg > svg')).toBeVisible();
  await expect(diagram.locator('script, foreignObject, a')).toHaveCount(0);
  await expect(diagram.locator('[onclick], [onerror], [onload], [href^="javascript:"]')).toHaveCount(0);
});
