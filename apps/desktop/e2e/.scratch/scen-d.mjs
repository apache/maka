/* Small viewport: a single Turn is taller than the mounted band, so the range
   must change mid-read. Measure what that does to the reader. */
import { boot, openSession, observe, drain, state, wheel, errorLines, report, SCROLLER } from './lib.mjs';

const C = 'd4b6549c-e51d-4c0b-97c8-9fa8ea79064b';
const B = '514ff457-46f1-47c5-b3f0-521d34faa1c7';
const { app, page, cdp, mainLog, rendererLog } = await boot();
await page.waitForTimeout(3000);
const mark = mainLog.length;
const all = [];
const log = async (tag) => {
  const b = await drain(page); all.push(...b.boundaries);
  const s = await state(page);
  console.log(`${tag}: ${JSON.stringify(s)}${b.boundaries.length ? '\n   bnd=' + JSON.stringify(b.boundaries) : ''}`);
  return s;
};

await openSession(page, C);
await page.waitForTimeout(3000);
await page.setViewportSize({ width: 900, height: 520 });
await page.waitForTimeout(1500);
await observe(page);
await log('C @900x520');

// crawl up with real pauses so the observer can settle between gestures
for (let r = 0; r < 45; r += 1) {
  await wheel(page, cdp, { ticks: 3, deltaY: -300 });
  await page.waitForTimeout(320);
  const b = await drain(page); all.push(...b.boundaries);
  if (b.boundaries.length) console.log(`up#${r} ${JSON.stringify(await state(page))}\n   ${JSON.stringify(b.boundaries)}`);
}
await log('C top @520');
report('small-up', all);

all.length = 0;
for (let r = 0; r < 45; r += 1) {
  await wheel(page, cdp, { ticks: 3, deltaY: 300 });
  await page.waitForTimeout(320);
  const b = await drain(page); all.push(...b.boundaries);
  if (b.boundaries.length) console.log(`down#${r} ${JSON.stringify(await state(page))}\n   ${JSON.stringify(b.boundaries)}`);
}
await log('C bottom @520');
report('small-down', all);

/* is the 420px-wide window actually dead, or was the wheel landing elsewhere? */
await page.setViewportSize({ width: 420, height: 900 });
await page.waitForTimeout(1500);
const box = await page.locator(SCROLLER).boundingBox();
console.log('scroller box @420:', JSON.stringify(box));
console.log('elementFromPoint at box centre:', JSON.stringify(await page.evaluate(([x, y]) => {
  const el = document.elementFromPoint(x, y);
  return { tag: el?.tagName, cls: el?.className?.toString?.().slice(0, 60), inScroller: !!el?.closest('[data-chat-scroll-container="true"]') };
}, [box.x + box.width / 2, box.y + box.height / 2])));
await log('C @420 before');
await wheel(page, cdp, { ticks: 25, deltaY: -400 });
await page.waitForTimeout(1200);
await log('C @420 after wheel up');
// also try programmatic scroll to prove the scroller can move at all
await page.evaluate((sel) => { document.querySelector(sel).scrollTop = 0; }, SCROLLER);
await page.waitForTimeout(800);
await log('C @420 after scrollTop=0');
await wheel(page, cdp, { ticks: 25, deltaY: 400 });
await page.waitForTimeout(1200);
await log('C @420 after wheel down');

console.log('=== handler errors ===', mainLog.slice(mark).filter((l) => /Error occurred in handler/.test(l)).length);
console.log('=== renderer errors ===');
console.log([...new Set(errorLines(rendererLog))].join('\n').slice(0, 2000));
await app.close().catch(() => {});
