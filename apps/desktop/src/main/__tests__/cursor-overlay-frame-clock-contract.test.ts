/**
 * The overlay's frame clock, not the engine's integrator.
 *
 * `cursor-engine.test.ts` drives `CursorEngine` directly, and that is the whole
 * reason the frame-rate defect survived being fixed once: the engine was taught
 * to sub-step a long frame, and the only production caller went on truncating
 * its own delta to 50ms one call earlier, so the engine was never handed a long
 * frame to sub-step and every engine test stayed green.
 *
 * `apps/desktop/src/overlay/cursor-overlay.ts` is a renderer entry point. It
 * touches `document`, `window` and `requestAnimationFrame` at module scope, so
 * it cannot be imported under `node --test` and there is no seam to observe the
 * call through. Asserting against the source text is the precedent already in
 * this directory (`app-region-hygiene-contract.test.ts`,
 * `startup-step-wiring-contract.test.ts`), for the same reason.
 *
 * Pinned twice, because the failure is a reintroduction rather than a rename:
 * the frame timestamp must be handed to the engine whole, and no delta may be
 * computed on this side of the call for anything to clamp.
 */
import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

const OVERLAY = resolve(import.meta.dirname, '../../../src/overlay/cursor-overlay.ts');

/**
 * Drop whole-line `//` comments, so prose about the frame clock cannot stand in
 * for the frame clock — the comment in that file names the very expression this
 * test forbids.
 */
function stripLineComments(source: string): string {
  return source
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n');
}

describe('cursor overlay frame clock', () => {
  it('hands the engine the frame timestamp, not a delta it computed', async () => {
    const overlay = stripLineComments(await readFile(OVERLAY, 'utf8'));
    assert.match(
      overlay,
      /engine\.tickTo\(\s*now\s*\)/,
      'the rAF timestamp must go to the engine whole; the delta is derived behind `tickTo`',
    );
  });

  it('computes no frame delta of its own for anything to clamp', async () => {
    const overlay = stripLineComments(await readFile(OVERLAY, 'utf8'));
    // The exact shape that made `cursorPresentationReadyDeadlineMs` a claim
    // about frame rate: `engine.tick(Math.min(0.05, (now - last) / 1000))`.
    assert.doesNotMatch(
      overlay,
      /engine\.tick\(/,
      '`tick` takes a delta the caller states, and a caller that states one can truncate it; '
        + 'the overlay must call `tickTo`',
    );
    // `last` was the other half of the same clock, and leaving it behind is how
    // a delta gets recomputed later.
    assert.doesNotMatch(
      overlay,
      /\blast\s*=\s*(?:now|performance\.now\(\))/,
      'the previous frame timestamp belongs to the engine; the overlay must not keep one',
    );
  });
});
