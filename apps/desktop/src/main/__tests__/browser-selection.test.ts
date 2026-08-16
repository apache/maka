import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createBrowserSelectionCoordinator } from '../../preload/browser-selection.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const flush = () => new Promise<void>((resolve) => queueMicrotask(resolve));

describe('browser selection ordering', () => {
  it('does not let a delayed selection resolution undo a newer hide', async () => {
    const pending = deferred<{ scope: string; sessionId: string }>();
    const events: string[] = [];
    const selection = createBrowserSelectionCoordinator(() => pending.promise, {
      show: (_documentId, generation, session) => events.push(`show:${generation}:${session.sessionId}`),
      hide: (_documentId, generation) => events.push(`hide:${generation}`),
      setViewport: () => undefined,
    }, 'document-a');

    selection.setActiveSession('desktop-a');
    selection.setActiveSession(null);
    pending.resolve({ scope: 'host-a', sessionId: 'runtime-a' });
    await flush();

    assert.deepEqual(events, ['hide:2']);
  });

  it('binds viewport delivery to the newest resolved selection generation', async () => {
    const sessions = new Map([
      ['desktop-a', deferred<{ scope: string; sessionId: string }>()],
      ['desktop-b', deferred<{ scope: string; sessionId: string }>()],
    ]);
    const events: string[] = [];
    const selection = createBrowserSelectionCoordinator(
      (sessionId) => sessions.get(sessionId)?.promise ?? Promise.reject(new Error('missing')),
      {
        show: (_documentId, generation, session) => events.push(`show:${generation}:${session.sessionId}`),
        hide: (_documentId, generation) => events.push(`hide:${generation}`),
        setViewport: (_documentId, generation, session) =>
          events.push(`viewport:${generation}:${session.sessionId}`),
      },
      'document-a',
    );

    selection.setActiveSession('desktop-a');
    selection.setViewport({ sessionId: 'desktop-a', rect: null });
    selection.setActiveSession('desktop-b');
    selection.setViewport({ sessionId: 'desktop-b', rect: null });
    sessions.get('desktop-b')?.resolve({ scope: 'host-b', sessionId: 'runtime-b' });
    sessions.get('desktop-a')?.resolve({ scope: 'host-a', sessionId: 'runtime-a' });
    await flush();

    assert.deepEqual(events, ['show:2:runtime-b', 'viewport:2:runtime-b']);
  });
});
