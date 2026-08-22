import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import type { RenderProcessGoneDetails } from 'electron';
import { observeMainRendererProcessGone } from '../main-renderer-process-gone.js';

test('observes one unexpected main Renderer exit while the app is running', () => {
  const source = new EventEmitter();
  const observed: RenderProcessGoneDetails[] = [];
  observeMainRendererProcessGone({
    source,
    shutdownSignal: new AbortController().signal,
    onUnexpectedExit: (details) => observed.push(details),
  });

  source.emit('render-process-gone', {}, { reason: 'oom', exitCode: 137 });
  source.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 11 });

  assert.deepEqual(observed, [{ reason: 'oom', exitCode: 137 }]);
});

test('ignores clean exits and app shutdown', () => {
  for (const scenario of [
    { aborted: false, details: { reason: 'clean-exit', exitCode: 0 } as const },
    { aborted: true, details: { reason: 'killed', exitCode: 9 } as const },
  ]) {
    const source = new EventEmitter();
    const abort = new AbortController();
    if (scenario.aborted) abort.abort();
    let observed = false;
    observeMainRendererProcessGone({
      source,
      shutdownSignal: abort.signal,
      onUnexpectedExit: () => {
        observed = true;
      },
    });

    source.emit('render-process-gone', {}, scenario.details);
    assert.equal(observed, false);
  }
});
