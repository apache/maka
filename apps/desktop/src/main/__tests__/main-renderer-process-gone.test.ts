import assert from 'node:assert/strict';
import { test } from 'node:test';
import { shouldReportMainRendererProcessGone } from '../main-renderer-process-gone.js';

test('reports only an unexpected main Renderer exit while the app is running', () => {
  for (const scenario of [
    { aborted: false, reason: 'clean-exit' as const, expected: false },
    { aborted: true, reason: 'killed' as const, expected: false },
    { aborted: false, reason: 'crashed' as const, expected: true },
  ]) {
    const abort = new AbortController();
    if (scenario.aborted) abort.abort();
    assert.equal(
      shouldReportMainRendererProcessGone(
        { reason: scenario.reason, exitCode: scenario.reason === 'clean-exit' ? 0 : 1 },
        abort.signal,
      ),
      scenario.expected,
    );
  }
});
