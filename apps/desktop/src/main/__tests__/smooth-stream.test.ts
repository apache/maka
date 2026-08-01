import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  computeFrameAdvance,
  prepareSmoothStreamText,
  resolveCompletionCps,
  resolveInitialDisplayedCount,
  resolveLiveBacklogCps,
  segmentGraphemes,
  updateEma,
} from '@maka/ui/smooth-stream';

describe('smooth stream helpers', () => {
  it('segments text without corrupting grapheme content', () => {
    assert.deepEqual(segmentGraphemes(''), []);
    assert.deepEqual(segmentGraphemes('hi'), ['h', 'i']);

    for (const text of ['🙂', '👨‍👩‍👧‍👦', '👍🏽', '🇨🇳', '\r\n', 'Hello 🙂 你好 👨‍👩‍👧 测试 🇨🇳!']) {
      assert.equal(segmentGraphemes(text).join(''), text);
    }
    if (typeof Intl.Segmenter === 'function') {
      for (const text of ['🙂', '👨‍👩‍👧‍👦', '👍🏽', '🇨🇳', '\r\n']) {
        assert.equal(segmentGraphemes(text).length, 1, text);
      }
    }
  });

  it('advances frames within backlog and speed bounds', () => {
    const base = {
      rawGraphemeCount: 100,
      displayedGraphemeCount: 0,
      emaCps: 60,
      dtMs: 16,
      minCps: 30,
      maxCps: 400,
    };
    const cases = [
      [{ ...base, rawGraphemeCount: 10, displayedGraphemeCount: 10 }, 0],
      [{ ...base, dtMs: 0 }, 1],
      [{ ...base, dtMs: -10 }, 1],
      [{ ...base, emaCps: 30 }, 1],
      [{ ...base, emaCps: 120, dtMs: 50 }, 6],
      [{ ...base, emaCps: 5, dtMs: 50 }, 1],
      [{ ...base, emaCps: 9999, dtMs: 50 }, 20],
      [{ ...base, rawGraphemeCount: 3, emaCps: 400, dtMs: 50 }, 3],
    ] as const;
    for (const [input, expected] of cases) {
      assert.equal(computeFrameAdvance(input), expected);
    }
  });

  it('raises live speed continuously and drains a burst within budget', () => {
    const base = { elapsedMs: 0, budgetMs: 2_000, emaCps: 80, minCps: 30, maxCps: 400 };
    assert.equal(resolveLiveBacklogCps({ ...base, backlog: 800 }), 400);
    assert.equal(resolveLiveBacklogCps({ ...base, backlog: 801 }), 401);
    assert.equal(resolveLiveBacklogCps({ ...base, backlog: 5_000 }), 2_500);

    const rawGraphemeCount = 5_000;
    const frameMs = 16;
    let displayedGraphemeCount = 0;
    let elapsedMs = 0;
    while (displayedGraphemeCount < rawGraphemeCount && elapsedMs < 20_000) {
      const frameCps = resolveLiveBacklogCps({
        ...base,
        backlog: rawGraphemeCount - displayedGraphemeCount,
        elapsedMs,
      });
      displayedGraphemeCount += computeFrameAdvance({
        rawGraphemeCount,
        displayedGraphemeCount,
        emaCps: frameCps,
        dtMs: frameMs,
        minCps: 30,
        maxCps: frameCps,
      });
      elapsedMs += frameMs;
    }
    assert.equal(displayedGraphemeCount, rawGraphemeCount);
    assert.ok(elapsedMs <= base.budgetMs + frameMs * 2, `catch-up took ${elapsedMs}ms`);
  });

  it('updates EMA only from positive finite observations', () => {
    assert.equal(updateEma({ prevEma: 50, alpha: 0.3, observedCps: 100 }), 65);
    for (const observedCps of [0, -100, Infinity, Number.NaN]) {
      assert.equal(updateEma({ prevEma: 50, alpha: 0.3, observedCps }), 50);
    }
  });

  it('chooses completion speed from the remaining tail and budget', () => {
    const base = { elapsedMs: 0, budgetMs: 500, emaCps: 80, minCps: 30, maxCps: 400 };
    const largeTailCps = resolveCompletionCps({
      ...base,
      rawGraphemeCount: 5_200,
      displayedGraphemeCount: 200,
    });
    assert.equal(largeTailCps, 10_000);
    assert.equal(
      computeFrameAdvance({
        rawGraphemeCount: 5_200,
        displayedGraphemeCount: 200,
        emaCps: largeTailCps,
        dtMs: 16,
        minCps: 30,
        maxCps: largeTailCps,
      }),
      160,
    );
    assert.equal(
      resolveCompletionCps({
        ...base,
        rawGraphemeCount: 260,
        displayedGraphemeCount: 200,
      }),
      120,
    );
  });

  it('initializes from snap and streaming state', () => {
    const cases = [
      [{ rawGraphemeCount: 500, streaming: true, snap: true }, 500],
      [{ rawGraphemeCount: 500, streaming: false, snap: true }, 500],
      [{ rawGraphemeCount: 2_000, streaming: false, snap: false }, 2_000],
      [{ rawGraphemeCount: 5, streaming: true, snap: false }, 0],
      [{ rawGraphemeCount: 0, streaming: true, snap: false }, 0],
    ] as const;
    for (const [input, expected] of cases) {
      assert.equal(resolveInitialDisplayedCount(input), expected);
    }
  });

  it('redacts secrets before any streamed prefix can render', () => {
    const secrets = [
      'sk-test1234567890ABCDEF',
      'sk-ant-1234567890abcdefghijklmnopqrstuvwxyz',
    ];
    const prepared = prepareSmoothStreamText(
      `Authorization: Bearer ${secrets[0]} planning to use ${secrets[1]}`,
    );
    for (const secret of secrets) assert.equal(prepared.includes(secret), false);

    const clean = 'normal reasoning step about the math';
    assert.equal(prepareSmoothStreamText(clean), clean);
    assert.equal(prepareSmoothStreamText(prepared), prepared);
    for (const input of [null, undefined, 42]) {
      assert.equal(prepareSmoothStreamText(input as unknown as string), '');
    }
  });
});
