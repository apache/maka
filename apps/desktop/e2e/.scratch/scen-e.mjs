/* Frame-accurate trace: does the frame that changes the mounted range move the
   reader more than the frames around it? Works during a gesture, unlike the
   quiet-frame method. */
import { boot, openSession, state, wheel, errorLines, SCROLLER } from './lib.mjs';

const TARGET = process.env.TARGET ?? 'd4b6549c-e51d-4c0b-97c8-9fa8ea79064b';
const H = Number(process.env.H ?? 520);

const { app, page, cdp, mainLog, rendererLog } = await boot();
await page.waitForTimeout(3000);
const mark = mainLog.length;
await openSession(page, TARGET);
await page.waitForTimeout(3000);
await page.setViewportSize({ width: 1000, height: H });
await page.waitForTimeout(1500);
console.log('start:', JSON.stringify(await state(page)));

await page.evaluate((sel) => {
  const sc = document.querySelector(sel);
  const frames = [];
  window.__trace = { frames, stop: () => { run = false; } };
  let run = true;
  const read = () => {
    const tops = {};
    for (const t of document.querySelectorAll('[data-turn-id]')) tops[t.dataset.turnId] = t.getBoundingClientRect().top;
    return { t: Math.round(performance.now()), st: sc.scrollTop, sh: sc.scrollHeight, key: Object.keys(tops).join(','), tops };
  };
  const tick = () => { if (!run) return; frames.push(read()); requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
}, SCROLLER);

const pass = async (dir, rounds) => {
  for (let r = 0; r < rounds; r += 1) {
    await wheel(page, cdp, { ticks: 3, deltaY: dir * 300 });
    await page.waitForTimeout(120);
  }
  await page.waitForTimeout(900);
};
await pass(-1, 40);
console.log('top:', JSON.stringify(await state(page)));
await pass(1, 45);
console.log('bottom:', JSON.stringify(await state(page)));

const analysis = await page.evaluate(() => {
  const frames = window.__trace.frames;
  window.__trace.stop();
  const out = [];
  for (let i = 1; i < frames.length; i += 1) {
    const a = frames[i - 1], b = frames[i];
    if (a.key === b.key) continue;
    const carried = Object.keys(b.tops).filter((id) => id in a.tops);
    // How far each surviving Turn moved on screen in this one frame.
    const moves = carried.map((id) => b.tops[id] - a.tops[id]);
    // What a frame around here normally moves: the median absolute per-frame
    // move of the same Turns across the nearest 6 same-key frames.
    const near = [];
    for (let j = Math.max(1, i - 6); j < Math.min(frames.length, i + 7); j += 1) {
      const p = frames[j - 1], q = frames[j];
      if (p.key !== q.key) continue;
      for (const id of carried) if (id in p.tops && id in q.tops) near.push(Math.abs(q.tops[id] - p.tops[id]));
    }
    near.sort((x, y) => x - y);
    const typical = near.length ? near[Math.floor(near.length / 2)] : 0;
    const worst = moves.length ? Math.max(...moves.map(Math.abs)) : 0;
    out.push({
      t: b.t, mounted: `${Object.keys(a.tops).length}->${Object.keys(b.tops).length}`,
      carried: carried.length, scrolledPx: Math.round(b.st - a.st), grewPx: Math.round(b.sh - a.sh),
      worstMovePx: Math.round(worst), typicalFramePx: Math.round(typical),
      excessPx: Math.round(worst - typical),
    });
  }
  return { frames: frames.length, changes: out };
});
console.log(`frames=${analysis.frames} rangeChangeFrames=${analysis.changes.length}`);
for (const c of analysis.changes) console.log('  ', JSON.stringify(c));
const bad = analysis.changes.filter((c) => c.carried > 0 && c.excessPx > 40);
console.log(`range-change frames that moved a surviving Turn >40px more than a normal frame: ${bad.length}`);
console.log('=== handler errors ===', mainLog.slice(mark).filter((l) => /Error occurred in handler/.test(l)).length);
console.log('=== renderer errors ==='); console.log([...new Set(errorLines(rendererLog))].join('\n').slice(0, 1500));
await app.close().catch(() => {});
