import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { LocaleProvider } from '@maka/ui';
import { rekeyPending } from '../../renderer/app-shell-pending-attachments.js';
import { useAppShellComposerAttachments } from '../../renderer/use-app-shell-composer-attachments.js';
import { useAppShellComposerQuotes } from '../../renderer/use-app-shell-composer-quotes.js';

/**
 * #3408 for what the composer STAGES. The draft text is covered by
 * `chat-composer-region-draft-handoff.test.ts`; attachments and quotes are
 * bucketed by the same `(profile, host, project)` key and drop out of the
 * composer on the same click of the workspace picker.
 */

const PROJECT_A = '["new-task","local","host","project-a"]';
const PROJECT_B = '["new-task","local","host","project-b"]';

const originalGlobals = {
  document: globalThis.document,
  window: globalThis.window,
  HTMLElement: globalThis.HTMLElement,
  Event: globalThis.Event,
  Node: globalThis.Node,
  IS_REACT_ACT_ENVIRONMENT: (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT,
};

let mountedRoot: Root | undefined;

afterEach(async () => {
  if (mountedRoot) await act(() => mountedRoot?.unmount());
  mountedRoot = undefined;
  Object.assign(globalThis, originalGlobals);
});

/**
 * Mount one composer-staging hook and return a `render(draftKey,
 * newTaskDraftKey)` for the two keys it distinguishes: the composer's ACTIVE
 * key, which a Session switch changes, and the new-task target's own key, which
 * only the workspace picker changes.
 */
async function mountProbe<T>(useHook: (options: {
  draftKey: string;
  newTaskDraftKey: string;
}) => T): Promise<{
  latest(): T;
  render(draftKey: string, newTaskDraftKey: string): Promise<void>;
}> {
  const { document, window } = parseHTML('<div id="root"></div>');
  Object.assign(globalThis, {
    document,
    window,
    HTMLElement: window.HTMLElement,
    Event: window.Event,
    Node: window.Node,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const container = document.querySelector('#root');
  assert.ok(container);
  const root = createRoot(container);
  mountedRoot = root;

  let latest: T | undefined;
  function Probe(props: { draftKey: string; newTaskDraftKey: string }) {
    latest = useHook(props);
    return null;
  }

  const render = async (draftKey: string, newTaskDraftKey: string) => {
    await act(async () => {
      root.render(
        createElement(LocaleProvider, {
          locale: 'en',
          children: createElement(Probe, { draftKey, newTaskDraftKey }),
        }),
      );
    });
  };

  return {
    latest: () => {
      assert.ok(latest);
      return latest;
    },
    render,
  };
}

function textFile(name: string): File {
  return { name, type: 'text/plain', size: 12 } as unknown as File;
}

test('staged quotes follow the Project chosen under the composer', async () => {
  const probe = await mountProbe(useAppShellComposerQuotes);

  await probe.render(PROJECT_A, PROJECT_A);
  await act(() => probe.latest().addQuote({ text: 'quoted line' }));
  assert.equal(probe.latest().pendingQuotes.length, 1);

  await probe.render(PROJECT_B, PROJECT_B);
  assert.deepEqual(
    probe.latest().pendingQuotes.map((quote) => quote.text),
    ['quoted line'],
  );
});

test('staged attachments follow the Project chosen under the composer', async () => {
  const probe = await mountProbe((options) =>
    useAppShellComposerAttachments({ ...options, toastApi: { error() {} } }),
  );

  await probe.render(PROJECT_A, PROJECT_A);
  await act(() => probe.latest().attachFilePaths([textFile('notes.txt')]));
  assert.equal(probe.latest().pendingAttachments.length, 1);

  await probe.render(PROJECT_B, PROJECT_B);
  assert.deepEqual(
    probe.latest().pendingAttachments.map((item) => item.displayName),
    ['notes.txt'],
  );
});

test('a Session keeps its own staged quotes when the new-task target moves', async () => {
  const probe = await mountProbe(useAppShellComposerQuotes);

  await probe.render('session-1', PROJECT_A);
  await act(() => probe.latest().addQuote({ text: 'quoted from the Session' }));

  // The catalog can settle, or another surface can move the target, while the
  // user is inside a Session. That must not reach the Session's own bucket…
  await probe.render('session-1', PROJECT_B);
  assert.equal(probe.latest().pendingQuotes.length, 1);

  // …nor hand the Session's quotes to the new-task composer on the way out.
  await probe.render(PROJECT_B, PROJECT_B);
  assert.equal(probe.latest().pendingQuotes.length, 0);
});

test('the target arrived at holds what was brought to it and nothing else', () => {
  const carried = rekeyPending({ [PROJECT_A]: ['one'] }, PROJECT_A, PROJECT_B);
  assert.deepEqual(carried, { [PROJECT_B]: ['one'] });

  // Nothing staged means the destination is emptied too, so a bucket that
  // outlived a send can never resurface as the next target's own staged set.
  const emptied = rekeyPending({ [PROJECT_B]: ['stale'] }, PROJECT_A, PROJECT_B);
  assert.deepEqual(emptied, {});

  // Untouched keys keep the same object, so no consumer re-renders for nothing.
  const unrelated = { 'session-1': ['kept'] };
  assert.equal(rekeyPending(unrelated, PROJECT_A, PROJECT_B), unrelated);
});
