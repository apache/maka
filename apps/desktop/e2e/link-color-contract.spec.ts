import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';

async function renderedLinkColors(page: Page, dark: boolean) {
  return page.evaluate(async (isDark) => {
    const root = document.documentElement;
    const renderedLink = document.querySelector<HTMLElement>('.settingsBotConfigDocLink')!;
    renderedLink.style.setProperty('transition', 'none', 'important');
    root.setAttribute('data-maka-theme', 'tokyo-night');
    root.classList.toggle('dark', isDark);
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

    const resolve = (value: string) => {
      const probe = document.createElement('span');
      probe.style.setProperty('color', value, 'important');
      document.body.appendChild(probe);
      const color = getComputedStyle(probe).color;
      probe.remove();
      return color;
    };
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    const context = canvas.getContext('2d', { willReadFrequently: true })!;
    const rgba = (value: string) => {
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = value;
      context.fillRect(0, 0, 1, 1);
      return [...context.getImageData(0, 0, 1, 1).data];
    };
    const colors = {
      link: rgba(resolve('var(--link)')),
      solid: rgba(resolve('var(--accent-solid)')),
      accent: rgba(resolve('var(--accent)')),
      rendered: rgba(getComputedStyle(renderedLink).color),
    };
    return colors;
  }, dark);
}

test('link text follows the solid accent tier in light and dark palettes', async ({
  linkColorWindow: page,
}) => {
  const light = await renderedLinkColors(page, false);
  const dark = await renderedLinkColors(page, true);
  for (const colors of [light, dark]) {
    expect(colors.link).toEqual(colors.solid);
    expect(colors.link).not.toEqual(colors.accent);
    expect(colors.rendered).toEqual(colors.link);
  }
  expect(dark.link).not.toEqual(light.link);
});
