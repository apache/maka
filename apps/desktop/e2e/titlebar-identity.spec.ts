import { test, expect } from './fixtures';

/**
 * The window titlebar states which session is open and which directory it runs
 * in. Both facts were previously unreachable from an open session: the name
 * lived only in the sidebar list, so collapsing that column erased it, and the
 * project lived only in the composer's WorkspacePicker, which stops rendering
 * the moment a session exists.
 *
 * The `sidebar-long-sessions` seed makes both deterministic — its active
 * session is 会话 00, bound to the 示例项目 project record.
 */
const IDENTITY = '[data-maka-contract="titlebar-identity"]';
const CONTENT_PLATE = '.maka-panel-detail';

const ICON_RAIL = '.maka-shell-topbar-rail';

/**
 * The strip's inter-column gap, read from the strip rather than restated: a
 * literal here fails the day `--space-2` is retuned, on a layout that is still
 * internally consistent.
 */
async function titlebarGap(page: import('@playwright/test').Page): Promise<number> {
  return page.evaluate(() => {
    const strip = document.querySelector('.maka-window-titlebar');
    return strip ? Number.parseFloat(getComputedStyle(strip).columnGap) : Number.NaN;
  });
}

/**
 * Where the breadcrumb sits horizontally, which no static CSS gate can answer.
 *
 * The strip spans the whole window while the shell below it is two columns, so
 * "left-aligned" is ambiguous until something measures it against them. Laid
 * out in normal flow the breadcrumb anchored to the icon rail and landed
 * mid-sidebar — straddling the seam, aligned with neither column.
 *
 * The two sidebar states have DIFFERENT right answers, which is why both are
 * measured. Expanded, the sidebar column is wide and the breadcrumb opens flush
 * with the conversation plate, reading as that plate's heading. Collapsed, the
 * icon rail is wider than the 48px column, so the plate edge runs underneath
 * the icons; the breadcrumb then clears the icons by the strip's own gap. One
 * rule produces both: it starts at whichever is further right.
 */
test('titlebar identity opens at the content plate edge, clearing the icon rail', async ({
  sidebarLongSessionsWindow: page,
}) => {
  const identity = page.locator(IDENTITY);
  await expect(identity).toBeVisible();
  const gap = await titlebarGap(page);

  const measure = async () => {
    const box = await identity.boundingBox();
    const plate = await page.locator(CONTENT_PLATE).boundingBox();
    const rail = await page.locator(ICON_RAIL).boundingBox();
    if (!box || !plate || !rail) throw new Error('titlebar strip not laid out');
    return { left: box.x, plateLeft: plate.x, railRight: rail.x + rail.width };
  };

  const expanded = await measure();
  expect(expanded.left).toBeCloseTo(expanded.plateLeft, 0);
  // Not the degenerate case where the rail happens to end at the same place.
  expect(expanded.plateLeft).toBeGreaterThan(expanded.railRight + gap);

  await page.getByRole('button', { name: '收起侧边栏' }).click();
  await expect(page.locator('[data-sidebar-state="collapsed"]')).toBeVisible();
  // The rail eases its width over `--duration-large`, and "has moved at all"
  // is true on the FIRST frame of that ease — while the assertions below only
  // hold once it has arrived. Poll for the destination: the plate's left edge
  // settles on the collapsed rail, which is the same seam `measure()` reads.
  await expect
    .poll(() =>
      page.evaluate(() => {
        const plate = document.querySelector('.maka-panel-detail')?.getBoundingClientRect();
        const frame = document.querySelector('.appFrame');
        if (!plate || !frame) return null;
        // The plate opens at the sidebar column's right edge, and that column's
        // width is the variable the collapse rebinds — so the destination is
        // stated by the same source the layout reads, not by a literal.
        const column = Number.parseFloat(
          getComputedStyle(frame).getPropertyValue('--maka-sidenav-width'),
        );
        return Math.round(plate.x - column);
      }),
    )
    .toBe(0);

  const collapsed = await measure();
  expect(collapsed.left).toBeCloseTo(collapsed.railRight + gap, 0);
  // Still on the conversation side of the seam, never back over the rail.
  expect(collapsed.left).toBeGreaterThan(collapsed.plateLeft);
});

/**
 * The session name must not read lighter in the titlebar than in the sidebar.
 *
 * Astryx's `supporting` breadcrumb variant — the obvious pick for a 36px strip,
 * and what this shipped as first — renders 12px/400/secondary. That made the
 * window's own statement of which session is open smaller, lighter and greyer
 * than the SAME session's row in the sidebar, and left the project and the
 * session typographically identical, with only the `›` separating them.
 *
 * Computed styles rather than a screenshot: this is a cascade fact, and the
 * regression is a one-word prop change that a pixel baseline would not name.
 */
test('the session name carries the sidebar row’s weight, and the project defers to it', async ({
  sidebarLongSessionsWindow: page,
}) => {
  const type = await page.evaluate(() => {
    const read = (el: Element | null) => {
      if (!el) return null;
      const style = getComputedStyle(el);
      return { size: style.fontSize, weight: style.fontWeight, color: style.color };
    };
    const identity = document.querySelector('[data-maka-contract="titlebar-identity"]');
    return {
      project: read(identity?.querySelector('.maka-titlebar-identity__segment') ?? null),
      session: read(
        identity?.querySelector('.maka-titlebar-identity__segment--session') ?? null,
      ),
      sidebarRow: read(document.querySelector('.astryx-side-nav-item[aria-current="page"]')),
    };
  });

  expect(type.session, JSON.stringify(type)).not.toBeNull();
  expect(type.sidebarRow, JSON.stringify(type)).not.toBeNull();

  // One session, one weight — whichever surface is naming it.
  expect(type.session?.size, JSON.stringify(type)).toBe(type.sidebarRow?.size);
  expect(type.session?.weight, JSON.stringify(type)).toBe(type.sidebarRow?.weight);

  // The pair has an internal hierarchy: the project is the context, not the
  // subject. Same size, lighter weight, quieter ink.
  expect(type.project?.size, JSON.stringify(type)).toBe(type.session?.size);
  expect(Number(type.project?.weight), JSON.stringify(type)).toBeLessThan(
    Number(type.session?.weight),
  );
  expect(type.project?.color, JSON.stringify(type)).not.toBe(type.session?.color);
});

test('titlebar names the open session and its project, in both sidebar states', async ({
  sidebarLongSessionsWindow: page,
}) => {
  const identity = page.locator(IDENTITY);
  await expect(identity).toContainText('示例项目');
  await expect(identity).toContainText('会话 00');

  // "The open session", not "the first row": both are 会话 00 at rest, so a
  // component wired to `sessions[0]` would read as correct until the user
  // opens something else. 会话 03 also changes the ANSWER to the project
  // question — the fixture links only its three newest sessions to 示例项目,
  // so this one falls back to the name derived from its cwd — which is what
  // makes this one click test both crumbs at once.
  await page
    .getByRole('navigation', { name: '对话列表' })
    .locator('[data-maka-contract="session-row"]')
    .filter({ hasText: '会话 03' })
    .first()
    .click();
  await expect(identity).toContainText('会话 03');
  await expect(identity).not.toContainText('会话 00');
  await expect(identity).not.toContainText('示例项目');
  await expect(identity).toContainText('maka');

  // The reason this lives in the titlebar rather than the sidebar: it has to
  // survive the column that used to be its only home.
  await page.getByRole('button', { name: '收起侧边栏' }).click();
  await expect(page.locator('[data-sidebar-state="collapsed"]')).toBeVisible();
  await expect(identity).toContainText('maka');
  await expect(identity).toContainText('会话 03');
});

test('renaming from the titlebar reaches storage and the sidebar row', async ({
  sidebarLongSessionsWindow: page,
}) => {
  const identity = page.locator(IDENTITY);
  await identity.getByRole('button', { name: /会话 00/ }).click();

  const field = identity.getByRole('textbox', { name: '重命名对话' });
  await expect(field).toBeFocused();
  await field.fill('标题栏改的名字');
  await field.press('Enter');

  // The full round trip: renderer → IPC → storage → session list → both
  // surfaces. Asserting the sidebar too is what proves this wrote through
  // rather than only repainting the titlebar's own state.
  await expect(identity).toContainText('标题栏改的名字');
  const sidebar = page.getByRole('navigation', { name: '对话列表' });
  await expect(sidebar.getByText('标题栏改的名字')).toBeVisible();
});

test('Escape abandons a titlebar rename instead of committing it', async ({
  sidebarLongSessionsWindow: page,
}) => {
  const identity = page.locator(IDENTITY);
  await identity.getByRole('button', { name: /会话 00/ }).click();

  const field = identity.getByRole('textbox', { name: '重命名对话' });
  await field.fill('不应该被保存');
  // Escape also blurs the field, and blur commits. React unmounts the input in
  // the same flush, so on this runtime the detached node's blur never lands and
  // the `escapeCancelledRef` guard inside InlineRenameInput is belt-and-braces
  // rather than the thing this line proves; what it does prove is that Escape
  // neither commits directly nor leaves the edit open.
  await field.press('Escape');

  await expect(identity).toContainText('会话 00');
  await expect(identity).not.toContainText('不应该被保存');
});

/**
 * The names a screen reader reads, which the visible text alone does not give.
 *
 * Both crumbs are actions — one opens the project folder, one starts a rename —
 * but their words name a place, so announced bare they are "示例项目, button"
 * and "会话 00, button": nothing says pressing them does anything. The action
 * phrase rides inside the control as visually hidden text, because Astryx
 * spreads unknown props onto the <li> rather than the button.
 */
test('each crumb announces its action, not just its label', async ({
  sidebarLongSessionsWindow: page,
}) => {
  const identity = page.locator(IDENTITY);
  await expect(identity.getByRole('button', { name: '示例项目 打开项目文件夹' })).toBeVisible();
  await expect(identity.getByRole('button', { name: '会话 00 重命名对话' })).toBeVisible();
});

/**
 * A long name must eat its own column, not the window.
 *
 * `min-width: 0` on the outer box alone clamped only that box: the nav and the
 * crumb buttons kept `min-width: auto`, so the text ran on past the clamp —
 * over the workspace actions and out into the strip's DRAG region, where a
 * click on the session name reaches the OS as a window drag. The ellipsis was
 * dead code, because nothing ever handed those elements a smaller size.
 *
 * Measured against the identity's own box, since that box IS the `no-drag`
 * rect: text outside it is text that cannot be clicked.
 */
test('a long session name truncates inside the no-drag rect', async ({
  sidebarLongSessionsWindow: page,
}) => {
  // 480px is the app's own window floor (SAFE_MIN_WIDTH in window-state.ts).
  // Pinning it is what makes the overflow certain: the field caps a name at 80
  // characters, so on a wide enough window — CI's is wider than this machine's
  // — the longest name a user can type still fits and the assertion passes for
  // the wrong reason.
  await page.setViewportSize({ width: 480, height: 800 });
  const identity = page.locator(IDENTITY);
  await identity.getByRole('button', { name: /会话 00/ }).click();
  const field = identity.getByRole('textbox', { name: '重命名对话' });
  await field.fill('很长的会话名字'.repeat(20));
  await field.press('Enter');
  await expect(identity).not.toContainText('会话 00');

  const overflow = await page.evaluate(() => {
    const box = document.querySelector('[data-maka-contract="titlebar-identity"]');
    const nav = box?.querySelector('nav');
    const segment = box?.querySelector('.maka-titlebar-identity__segment--session');
    if (!box || !nav || !segment) return null;
    return {
      navRight: nav.getBoundingClientRect().right,
      boxRight: box.getBoundingClientRect().right,
      actionsLeft:
        document.querySelector('.maka-workspace-top-actions')?.getBoundingClientRect().left ?? 0,
      // Truncated, therefore ellipsized: equal widths mean the text fit and
      // the whole chain never engaged.
      clipped: segment.scrollWidth > segment.clientWidth,
    };
  });

  expect(overflow, 'titlebar identity not laid out').not.toBeNull();
  expect(overflow!.navRight).toBeLessThanOrEqual(overflow!.boxRight + 1);
  expect(overflow!.boxRight).toBeLessThanOrEqual(overflow!.actionsLeft + 1);
  expect(overflow!.clipped, JSON.stringify(overflow)).toBe(true);
});

/**
 * Clicking away commits, the same way the sidebar's rename does.
 *
 * Every other rename test leaves through Enter or Escape, and both unmount the
 * field in the same flush — so deleting `onBlur` outright left the whole suite
 * green while a user who clicked away was stuck in an edit that never landed.
 */
test('clicking away commits a titlebar rename', async ({ sidebarLongSessionsWindow: page }) => {
  const identity = page.locator(IDENTITY);
  await identity.getByRole('button', { name: /会话 00/ }).click();

  const field = identity.getByRole('textbox', { name: '重命名对话' });
  await field.fill('点击别处也要保存');
  await page.locator(CONTENT_PLATE).click({ position: { x: 40, y: 200 } });

  await expect(identity).toContainText('点击别处也要保存');
  const sidebar = page.getByRole('navigation', { name: '对话列表' });
  await expect(sidebar.getByText('点击别处也要保存')).toBeVisible();
});

/**
 * Editing a name must not move it.
 *
 * The field used to bring a box of its own — a bottom border and its own
 * padding the crumb did not have — so the trail lost a pixel of height and the
 * first glyph stepped 4px left the moment the label became editable. The field
 * now inherits the crumb's type and draws its focus line with a `box-shadow`,
 * which paints outside layout.
 */
test('starting a rename leaves the trail exactly where it was', async ({
  sidebarLongSessionsWindow: page,
}) => {
  const identity = page.locator(IDENTITY);
  const read = () =>
    page.evaluate(() => {
      const root = document.querySelector('[data-maka-contract="titlebar-identity"]')!;
      const field = root.querySelector('input');
      const label = root.querySelector('.maka-titlebar-identity__segment--session');
      const text = (field ?? label)!.getBoundingClientRect();
      const pad = field ? Number.parseFloat(getComputedStyle(field).paddingLeft) : 0;
      const project = root.querySelector('.maka-titlebar-identity__segment')!.getBoundingClientRect();
      return {
        stripHeight: Math.round(root.getBoundingClientRect().height),
        projectX: Math.round(project.x),
        projectWidth: Math.round(project.width),
        // Where the first glyph lands, which is what the eye tracks.
        textLeft: Math.round(text.x + pad),
        textMiddle: Math.round(text.y + text.height / 2),
      };
    });

  const before = await read();
  await identity.getByRole('button', { name: /会话 00/ }).click();
  await expect(identity.getByRole('textbox', { name: '重命名对话' })).toBeFocused();

  expect(await read()).toEqual(before);
});

/**
 * A long name must not cost the user the ability to move the window.
 *
 * This window has no OS title bar, so the strip is the drag handle, and the
 * breadcrumb is a grid item that grows to its content. At `max-width: 100%` a
 * maximal name took the whole middle column: measured on a 1000px window, the
 * band between the trail and the actions cluster collapsed from 526px to 8px
 * and the strip's total draggable width fell from ~730px to 216px.
 *
 * Not a `no-drag` hygiene bug — the wide box was covered by the crumb button,
 * so `no-drag` still matched the interactive area. The rect was honest; it was
 * simply allowed to eat everything. What this pins is the reserve.
 */
test('a maximal session name still leaves the strip a band to drag by', async ({
  sidebarLongSessionsWindow: page,
}) => {
  const identity = page.locator(IDENTITY);
  await identity.getByRole('button', { name: /会话 00/ }).click();
  const field = identity.getByRole('textbox', { name: '重命名对话' });
  // 80 characters is the field's own cap, so this is the widest a name gets.
  await field.fill('很长的会话名字'.repeat(20));
  await field.press('Enter');
  await expect(identity).not.toContainText('会话 00');

  const band = await page.evaluate(() => {
    const box = document.querySelector('[data-maka-contract="titlebar-identity"]')!;
    const rect = box.getBoundingClientRect();
    const actions = document.querySelector('.maka-workspace-top-actions')!.getBoundingClientRect();
    const midY = rect.y + rect.height / 2;
    const midX = (rect.right + actions.left) / 2;
    const under = document.elementFromPoint(midX, midY);
    return {
      width: Math.round(actions.left - rect.right),
      // Empty is not the same as draggable: the point has to reach the OS as
      // window chrome, which is what the strip's one `drag` declaration does.
      region: under ? getComputedStyle(under).getPropertyValue('-webkit-app-region').trim() : null,
      clipped: (() => {
        const seg = box.querySelector('.maka-titlebar-identity__segment--session')!;
        return seg.scrollWidth > seg.clientWidth;
      })(),
    };
  });

  // The name is long enough to be pressing on the reserve, not merely short.
  expect(band.clipped, JSON.stringify(band)).toBe(true);
  expect(band.width, JSON.stringify(band)).toBeGreaterThan(64);
  expect(band.region, JSON.stringify(band)).toBe('drag');
});

/**
 * Clearing the field abandons the edit, quietly.
 *
 * The name survives either way — storage rejects an empty one — so what the
 * `name &&` guard actually holds is that an abandoned edit is not REPORTED as
 * a failure. Deleting it sends the empty string down to the main process,
 * which refuses it, and the user gets 重命名会话失败 for an edit they simply
 * walked away from. Verified by deleting the guard: the name stayed 会话 00
 * and the toast appeared, which is why this asserts the toast and not the
 * name alone.
 */
test('clearing the titlebar field abandons the rename without reporting a failure', async ({
  sidebarLongSessionsWindow: page,
}) => {
  const identity = page.locator(IDENTITY);
  await identity.getByRole('button', { name: /会话 00/ }).click();
  const field = identity.getByRole('textbox', { name: '重命名对话' });
  await field.fill('   ');
  await field.press('Enter');

  // A one-shot `count()`, not `toHaveCount(0)`, and before the name check.
  // Both of the obvious spellings pass while the bug is present: the retrying
  // matcher simply waits out the toast's own six seconds and then agrees it is
  // gone, and putting the name assertion first spends those same seconds
  // waiting for the crumb to come back from blank. The absence has to be read
  // once, at a moment a real toast would still be on screen.
  await page.waitForTimeout(1_000);
  expect(await page.getByText('重命名会话失败').count()).toBe(0);
  await expect(identity).toContainText('会话 00');
});

/**
 * A keyboard exit hands focus back to the crumb it came from.
 *
 * The crumb is not hidden while the field is up — it is unmounted — so without
 * a hand-back the edit ends with focus on the document body and the next Tab
 * starts at the top of the window. A click-away is deliberately excluded: it
 * already put focus where the user pointed.
 */
test('ending a titlebar rename from the keyboard returns focus to the crumb', async ({
  sidebarLongSessionsWindow: page,
}) => {
  const identity = page.locator(IDENTITY);
  const crumb = identity.getByRole('button', { name: /会话 00/ });

  await crumb.click();
  await identity.getByRole('textbox', { name: '重命名对话' }).press('Escape');
  await expect(crumb).toBeFocused();

  await crumb.click();
  await identity.getByRole('textbox', { name: '重命名对话' }).press('Enter');
  await expect(crumb).toBeFocused();
});
