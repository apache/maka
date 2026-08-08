/**
 * The one Design System story that survived the token-catalog cut, because the
 * test that removed the others does not apply to it.
 *
 * Those stories were tables of Maka's own `--space-*`, `--font-size-*`,
 * `--shadow-*` and `--z-*` values. Astryx ships parallel contracts for all of
 * them and `maka-tokens.css` dies with Slice 13 (#1565), so a catalog of var
 * names carries little review value and a short remaining life. That is the
 * reason they went — NOT that Astryx has already taken the domain over, which
 * is not true today: `maka-tokens.css` is still the single authority and
 * `makaTheme` is a plain extend of Astryx's neutral theme.
 *
 * The palette matrix is different in kind. `THEME_PALETTES` is a product
 * feature — the palettes a user picks in 设置 → 外观 — and every one of them
 * except `default` is unreachable from any other story, including the
 * appearance page's own. The smoke's catalog pass renders wide/light/default
 * only, so without this story ten palettes have no oracle whatsoever.
 */
import type { Meta, StoryObj } from '@storybook/react-vite';
import { useSyncExternalStore } from 'react';
import { expect } from 'storybook/test';
import { THEME_PALETTES } from '../../../packages/core/src/settings.js';

const meta = {
  title: 'Design System/Palette Matrix',
  parameters: { layout: 'padded' },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

function subscribe(callback: () => void): () => void {
  const el = document.documentElement;
  const observer = new MutationObserver(callback);
  observer.observe(el, { attributes: true, attributeFilter: ['class'] });
  return () => observer.disconnect();
}

function getSnapshot(): boolean {
  return document.documentElement.classList.contains('dark');
}

function getServerSnapshot(): boolean {
  return false;
}

function useIsDark(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

const paletteTokens = [
  ['background', '--background'],
  ['foreground', '--foreground'],
  ['accent', '--accent'],
  ['info', '--info'],
  ['success', '--success'],
  ['destructive', '--destructive'],
] as const;

function cssColorToRgb(color: string): readonly [number, number, number] {
  const canvas = document.createElement('canvas');
  canvas.width = 1;
  canvas.height = 1;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('Palette contrast check requires a 2D canvas context');
  context.fillStyle = color;
  context.fillRect(0, 0, 1, 1);
  const [red, green, blue] = context.getImageData(0, 0, 1, 1).data;
  return [red ?? 0, green ?? 0, blue ?? 0];
}

function relativeLuminance([red, green, blue]: readonly [number, number, number]): number {
  const linear = [red, green, blue].map((channel) => {
    const srgb = channel / 255;
    return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * (linear[0] ?? 0) + 0.7152 * (linear[1] ?? 0) + 0.0722 * (linear[2] ?? 0);
}

function contrastRatio(foreground: string, background: string): number {
  const foregroundLuminance = relativeLuminance(cssColorToRgb(foreground));
  const backgroundLuminance = relativeLuminance(cssColorToRgb(background));
  const lighter = Math.max(foregroundLuminance, backgroundLuminance);
  const darker = Math.min(foregroundLuminance, backgroundLuminance);
  return (lighter + 0.05) / (darker + 0.05);
}

export const AllPalettes: Story = {
  render: () => {
    const isDark = useIsDark();
    return (
      <section style={{ display: 'grid', gap: 20, maxWidth: 920 }}>
        <div style={{ display: 'grid', gap: 4 }}>
          <h2 style={{ fontSize: 16, fontWeight: 600, margin: 0 }}>Palette Matrix</h2>
          <p style={{ color: 'var(--foreground-secondary)', fontSize: 12, margin: 0, lineHeight: 1.5 }}>
            {THEME_PALETTES.length} 个 palette,用工具栏切 light/dark 查看另一组。每个块独立应用 data-maka-theme。
          </p>
        </div>
        <div
          style={{
            display: 'grid',
            gap: 12,
            gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))',
          }}
        >
          {THEME_PALETTES.map((palette) => (
            <div
              key={palette}
              data-maka-theme={palette}
              className={isDark ? 'dark' : undefined}
              style={{
                display: 'grid',
                gap: 8,
                padding: 12,
                borderRadius: 'var(--radius-surface)',
                boxShadow: 'var(--shadow-minimal-flat)',
                background: 'var(--background)',
                color: 'var(--foreground)',
              }}
            >
              <strong style={{ fontSize: 13, fontWeight: 650 }}>{palette}</strong>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {paletteTokens.map(([name, token]) => (
                  <div key={token} style={{ display: 'grid', gap: 3, placeItems: 'center' }}>
                    <div
                      style={{
                        background: `var(${token})`,
                        borderRadius: 'var(--radius-control)',
                        boxShadow: 'inset 0 0 0 1px var(--border)',
                        height: 28,
                        width: 28,
                      }}
                      title={`${name}: ${token}`}
                    />
                  </div>
                ))}
              </div>
              <a
                data-palette-link={palette}
                href="#palette-link"
                style={{ color: 'var(--link)', fontSize: 12 }}
              >
                Readable link
              </a>
            </div>
          ))}
        </div>
      </section>
    );
  },
  play: async ({ canvasElement }) => {
    const links = canvasElement.querySelectorAll<HTMLAnchorElement>('[data-palette-link]');
    for (const link of links) {
      const surface = link.closest<HTMLElement>('[data-maka-theme]');
      if (!surface) throw new Error('Palette link is missing its theme surface');
      const ratio = contrastRatio(
        getComputedStyle(link).color,
        getComputedStyle(surface).backgroundColor,
      );
      await expect(ratio, `${link.dataset.paletteLink} link contrast`).toBeGreaterThanOrEqual(4.5);
    }
  },
};
