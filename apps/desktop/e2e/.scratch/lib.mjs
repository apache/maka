import { launchReal } from './harness.mjs';

export const SCROLLER = '[data-chat-scroll-container="true"]';

export async function boot() {
  const ctx = await launchReal();
  ctx.cdp = await ctx.page.context().newCDPSession(ctx.page);
  ctx.page.on('console', (m) => ctx.rendererLog.push(`${m.type()} ${m.text().slice(0, 300)}`));
  ctx.page.on('pageerror', (e) => ctx.rendererLog.push(`PAGEERROR ${e.stack?.split('\n').slice(0, 3).join(' | ') ?? e.message}`));
  return ctx;
}

export async function openSession(page, sessionId, { wait = true } = {}) {
  const row = page.locator(`[data-maka-contract="session-row"][data-session-id*="${sessionId}"]`).first();
  await row.waitFor({ state: 'visible', timeout: 15000 });
  await row.click();
  if (wait) await page.waitForTimeout(2500);
}

export async function observe(page) {
  await page.evaluate((sel) => {
    const scroller = document.querySelector(sel);
    if (!scroller) throw new Error('no scroller');
    const read = () => {
      const tops = new Map();
      for (const t of document.querySelectorAll('[data-turn-id]')) tops.set(t.dataset.turnId, t.getBoundingClientRect().top);
      const gap = (d) => {
        const r = document.querySelector(`[data-transcript-gap="${d}"]`);
        return r ? r.getBoundingClientRect().height : 0;
      };
      return {
        scrollTop: scroller.scrollTop, scrollHeight: scroller.scrollHeight,
        olderGap: gap('older'), newerGap: gap('newer'), tops, key: [...tops.keys()].join(','),
      };
    };
    const state = { boundaries: [], peakMounted: 0, frames: 0, stop: () => { running = false; } };
    window.__probe = state;
    let running = true;
    let lastWheelAt = -Infinity;
    document.addEventListener('wheel', () => { lastWheelAt = performance.now(); }, true);
    let previous = read();
    let settled = null;
    const tick = () => {
      if (!running) return;
      state.frames += 1;
      let current;
      try { current = read(); } catch { requestAnimationFrame(tick); return; }
      state.peakMounted = Math.max(state.peakMounted, current.tops.size);
      if (performance.now() - lastWheelAt < 250) { settled = null; previous = current; requestAnimationFrame(tick); return; }
      if (current.key !== previous.key) { if (!settled) settled = previous; }
      else if (settled) {
        const before = settled; settled = null;
        let carried = 0, worstPx = 0, worstTurnId = null;
        for (const [id, top] of current.tops) {
          const was = before.tops.get(id);
          if (was === undefined) continue;
          carried += 1;
          const d = Math.abs(top - was);
          if (d > worstPx) { worstPx = d; worstTurnId = id; }
        }
        state.boundaries.push({
          at: Math.round(performance.now()),
          mountedBefore: before.tops.size, mountedAfter: current.tops.size,
          scrolledPx: Math.round(current.scrollTop - before.scrollTop),
          grewPx: Math.round(current.scrollHeight - before.scrollHeight),
          olderGapPx: `${Math.round(before.olderGap)}->${Math.round(current.olderGap)}`,
          newerGapPx: `${Math.round(before.newerGap)}->${Math.round(current.newerGap)}`,
          carried, worstTurnId, worstPx: Math.round(worstPx),
        });
      }
      previous = current;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, SCROLLER);
}

export async function drain(page) {
  return page.evaluate(() => {
    const s = window.__probe;
    if (!s) return { boundaries: [], peakMounted: 0 };
    const out = { boundaries: s.boundaries.slice(), peakMounted: s.peakMounted };
    s.boundaries.length = 0;
    return out;
  });
}

export async function state(page) {
  return page.evaluate((sel) => {
    const sc = document.querySelector(sel);
    const turns = [...document.querySelectorAll('[data-turn-id]')];
    return {
      mounted: turns.length,
      first: turns[0]?.dataset.turnId ?? null,
      last: turns.at(-1)?.dataset.turnId ?? null,
      scrollTop: sc ? Math.round(sc.scrollTop) : null,
      scrollHeight: sc ? Math.round(sc.scrollHeight) : null,
      clientHeight: sc ? Math.round(sc.clientHeight) : null,
      olderGap: Math.round(document.querySelector('[data-transcript-gap="older"]')?.getBoundingClientRect().height ?? 0),
      newerGap: Math.round(document.querySelector('[data-transcript-gap="newer"]')?.getBoundingClientRect().height ?? 0),
    };
  }, SCROLLER);
}

export async function wheel(page, cdp, { ticks = 1, deltaY = -300, settle = 'frame' } = {}) {
  const box = await page.locator(SCROLLER).boundingBox();
  if (!box) throw new Error('scroller has no box');
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  for (let i = 0; i < ticks; i += 1) {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY });
    if (settle === 'frame') await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r())));
  }
  if (settle !== 'none') {
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
  }
}

export function errorLines(log) {
  return log.filter((l) => /Error occurred in handler|RangeError|PAGEERROR|Unhandled|rejection|TypeError|Invariant/i.test(l));
}

export function report(label, boundaries) {
  const bad = boundaries.filter((b) => b.worstPx > 40);
  console.log(`[${label}] boundaries=${boundaries.length} worst=${Math.max(0, ...boundaries.map((b) => b.worstPx))}px over40=${bad.length}`);
  for (const b of bad.slice(0, 12)) console.log(`  JUMP ${JSON.stringify(b)}`);
  return bad;
}
