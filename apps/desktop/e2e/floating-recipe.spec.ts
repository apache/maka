import { test, expect } from './fixtures';

// Guard for the `@astryxdesign/core` floating-surface patch (patches/README).
//
// DESIGN.md §5: every portal surface is `--surface-overlay` fill +
// `--border-soft` ring + `--elevation-overlay` + `overflow: hidden` + container
// radius. Astryx ships the fill and the radius and hardcodes the other three
// wrong — it reaches for the LOW shadow (which is --elevation-raised), leaves
// the surface ringless, and leaves `overflow: visible` so content corners
// escape the surface's own radius.
//
// The painted surface is an anonymous wrapper OUTSIDE `[role=menu]`, carrying
// no themeProps label, so the patch adds one hook class and the recipe itself
// lives in product CSS (styles/astryx-mount.css). This asserts the RESULT, not
// the hook: if Astryx ever ships the recipe itself, this stays green with the
// patch deleted, which is exactly the deletion condition.
test('a portal surface wears the floating recipe, not a plate shadow', async ({ window: page }) => {
  await page.getByRole('button', { name: /选择新对话模型/ }).click();
  // `[role="menu"]` specifically: the composer keeps a permanently-mounted,
  // hidden `[role="listbox"]` for slash suggestions, which a looser selector
  // matches first and which never paints a surface.
  const menu = page.getByRole('menu');
  await expect(menu).toBeVisible();

  const surface = await page.evaluate(() => {
    const el = document.querySelector('[role="menu"]');
    if (!el) return null;
    // Walk out to whatever actually paints — the assertion must not care which
    // node that is, only that the surface the user sees follows the recipe.
    let node: Element | null = el;
    while (node && node !== document.documentElement) {
      const cs = getComputedStyle(node);
      if (cs.backgroundColor && !/rgba\(0, 0, 0, 0\)|transparent/.test(cs.backgroundColor)) {
        return {
          radius: cs.borderTopLeftRadius,
          borderWidth: cs.borderTopWidth,
          borderStyle: cs.borderTopStyle,
          overflow: cs.overflow,
          shadow: cs.boxShadow,
        };
      }
      node = node.parentElement;
    }
    return null;
  });

  expect(surface).not.toBeNull();
  // Ring present. Its colour is --border-soft; the load-bearing part is that a
  // ring exists at all, since a ringless overlay leans entirely on the shadow.
  expect(surface!.borderStyle).toBe('solid');
  expect(surface!.borderWidth).not.toBe('0px');
  // Container radius (DESIGN.md §6) with clipping, so children cannot square
  // off the corners the surface just drew.
  expect(surface!.radius).toBe('12px');
  expect(surface!.overflow).toBe('hidden');
  // Overlay elevation, not raised. The two scales differ in the second layer's
  // blur — overlay is 12px where raised is 8px — which is the cheapest stable
  // way to tell them apart without pinning the whole shadow string.
  expect(surface!.shadow).toContain('12px');
  expect(surface!.shadow).not.toContain('4px 8px');
});
