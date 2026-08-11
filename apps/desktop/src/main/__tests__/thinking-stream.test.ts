/**
 * Tests for the PR-UI-C0 review fixup `applyThinkingDelta` /
 * `applyThinkingComplete` pure helpers (@kenji A3-style trust-
 * boundary review msg 7885a347).
 *
 * Anthropic extended-thinking is model output and can echo
 * prompts / env / tool stderr / pasted credentials past the
 * provider's redactor. The renderer-side helpers enforce:
 *
 *   1. Secondary `redactSecrets` BEFORE state — raw bearer / API
 *      key text never reaches React state, DevTools snapshot, or
 *      the `<pre>` render path.
 *   2. Per-delta cap (4 KB) — a single misbehaving multi-MB delta
 *      tail-keeps with a marker.
 *   3. Per-session total cap (32 KB) — sustained streaming tail-
 *      keeps the most recent reasoning with a head marker, so the
 *      user sees the current chain of thought.
 *
 * Imported from `@maka/ui` barrel (mirrors the tool-output-stream
 * test pattern).
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  THINKING_MAX_DELTA_CHARS,
  THINKING_MAX_TOTAL_CHARS,
  applyThinkingComplete,
  applyThinkingDelta,
} from '@maka/ui';

describe('applyThinkingDelta — secondary redaction', () => {
  it('masks raw `Authorization: Bearer ...` text before storing', () => {
    const result = applyThinkingDelta(
      'reasoning so far...\n',
      'I should call the API with Authorization: Bearer sk-test1234567890ABCDEF and check the response',
    );
    assert.equal(result.redacted, true);
    // The actual mask token comes from @maka/ui redactSecrets; the
    // contract that matters is the raw bearer never survives.
    assert.equal(
      result.text.includes('sk-test1234567890ABCDEF'),
      false,
      'raw token must NOT survive into stored thinking state',
    );
  });

  it('masks bare API-key prefixes inside thinking', () => {
    const result = applyThinkingDelta('', 'planning to use sk-ant-1234567890abcdefghijklmnopqrstuvwxyz for this');
    assert.equal(result.redacted, true);
    assert.equal(
      result.text.includes('sk-ant-1234567890abcdefghijklmnopqrstuvwxyz'),
      false,
    );
  });


});

describe('applyThinkingDelta — per-delta cap', () => {
  function filler(len: number): string {
    let out = '';
    let i = 0;
    while (out.length < len) {
      out += `reasoning step ${i}: examining the next consideration.\n`;
      i += 1;
    }
    return out.slice(0, len);
  }

  it('tail-keeps a single oversize delta with a truncation marker', () => {
    const big = filler(THINKING_MAX_DELTA_CHARS * 3);
    const result = applyThinkingDelta('', big);
    assert.equal(result.truncated, true);
    // After truncation the appended segment must fit in maxDelta.
    assert.ok(
      result.text.length <= THINKING_MAX_DELTA_CHARS,
      `result.text.length=${result.text.length} should be <= ${THINKING_MAX_DELTA_CHARS}`,
    );
  });


});

describe('applyThinkingDelta — per-session total cap', () => {
  function chunk(len: number, label: string): string {
    let out = '';
    while (out.length < len) {
      out += `[${label}] reasoning continues here.\n`;
    }
    return out.slice(0, len);
  }

  it('tail-keeps when accumulated total exceeds maxTotal', () => {
    // Push small deltas until we cross the total cap. Each delta is
    // well under the per-delta cap so truncated should fire only on
    // the total-cap path, not the per-delta path.
    let prev = '';
    for (let i = 0; i < 12; i += 1) {
      const delta = chunk(3 * 1024, `step-${i}`);
      const result = applyThinkingDelta(prev, delta);
      prev = result.text;
    }
    assert.ok(
      prev.length <= THINKING_MAX_TOTAL_CHARS,
      `accumulated text length=${prev.length} should be <= ${THINKING_MAX_TOTAL_CHARS}`,
    );
    // Most recent reasoning preserved: the last few `[step-11]`
    // markers must survive.
    assert.ok(prev.includes('[step-11]'), 'newest reasoning must survive');
    // Oldest dropped: `[step-0]` should be gone.
    assert.equal(prev.includes('[step-0]'), false, 'oldest reasoning must drop');
  });

});

describe('applyThinkingComplete — final replace path', () => {
  it('replaces (not appends) the prior text — final payload is full', () => {
    // applyThinkingComplete signature accepts only the raw final
    // text; the caller (renderer) is responsible for picking up the
    // result and overwriting state.
    const result = applyThinkingComplete('this is the FULL final reasoning text');
    assert.equal(result.text, 'this is the FULL final reasoning text');
    assert.equal(result.redacted, false);
    assert.equal(result.truncated, false);
  });

  it('redacts secrets in the final payload', () => {
    const result = applyThinkingComplete('final thinking with Authorization: Bearer sk-secret123ABC ...');
    assert.equal(result.redacted, true);
    assert.equal(result.text.includes('sk-secret123ABC'), false);
  });

  it('tail-keeps when the final payload exceeds the total cap', () => {
    const huge = 'paragraph of reasoning. '.repeat(5000); // ~115 KB
    const result = applyThinkingComplete(huge);
    assert.equal(result.truncated, true);
    assert.ok(result.text.length <= THINKING_MAX_TOTAL_CHARS);
  });

});

describe('applyThinkingDelta — combined secret + oversize', () => {
  it('secret never appears in stored text regardless of which gate fires', () => {
    const noise = 'reasoning step '.repeat(2000); // > maxDelta
    const secret = 'Authorization: Bearer sk-secret1234567890ABCDEF';
    const result = applyThinkingDelta('', noise + secret);
    // Either redaction or truncation (or both) may have fired; the
    // ONLY contract that matters here: secret never in result.text.
    assert.equal(result.text.includes('sk-secret1234567890ABCDEF'), false);
  });
});
