// Behavior contract for the Computer Use menu bar status item. Driven against a
// fake Tray (no Electron main process), asserting the properties that make it
// worth having at all, and the ones it inherits from Codex's
// `CUAServiceStatusItemController`:
//  - it appears while something is driving the machine, and is bound to the
//    NUMBER of live sessions, not to how recently an action happened
//  - it is independent of the cursor, which hides whenever the target is covered
//  - one row per live session, titled with the app that session is driving
//  - one glyph, no second "idle" artwork, no timers, no tooltip
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createComputerUseStatusItem,
  withComputerUseStatusItem,
} from '../computer-use/status-item.js';

type MenuTemplate = Array<{ label?: string; enabled?: boolean; type?: string; click?: () => void }>;

class FakeTray {
  images: string[] = [];
  tooltips: string[] = [];
  menus: MenuTemplate[] = [];
  destroyed = false;
  ignoreDoubleClick = false;
  setImage(image: unknown): void {
    this.images.push(String((image as { name?: string }).name));
  }
  setToolTip(text: string): void {
    this.tooltips.push(text);
  }
  setContextMenu(menu: unknown): void {
    this.menus.push((menu as { template: MenuTemplate }).template);
  }
  setIgnoreDoubleClickEvents(value: boolean): void {
    this.ignoreDoubleClick = value;
  }
  destroy(): void {
    this.destroyed = true;
  }
}

function makeItem(
  overrides: {
    onStopRequested?: (sessionId: string) => void;
    onLiveChanged?: (live: boolean) => void;
    resolveLocale?: () => 'zh' | 'en';
  } = {},
) {
  const trays: FakeTray[] = [];
  const images: unknown[] = [];
  const item = createComputerUseStatusItem({
    loadImage: () => {
      const image = { name: 'cu-status' };
      images.push(image);
      return image as never;
    },
    buildMenu: (template) => ({ template }) as never,
    createTray: (image) => {
      const tray = new FakeTray();
      tray.images.push(String((image as unknown as { name?: string }).name));
      trays.push(tray);
      return tray as never;
    },
    // Stated rather than inherited: these rows are locale-dependent now, so a
    // test that asserts English text has to say it is asking for English.
    resolveLocale: () => 'en',
    ...overrides,
  });
  return { item, trays, images };
}

function rows(tray: FakeTray | undefined): MenuTemplate {
  return tray?.menus.at(-1) ?? [];
}

function labels(tray: FakeTray | undefined): string[] {
  return rows(tray).map((entry) => entry.label ?? '');
}

test('Computer Use status item', async (t) => {
  await t.test('stays hidden until a session drives something', () => {
    const { item, trays } = makeItem();
    assert.equal(item.isVisible(), false);
    assert.equal(trays.length, 0);
  });

  await t.test('appears on the first action', () => {
    const { item, trays } = makeItem();
    item.noteSessionActive('s1');
    assert.equal(item.isVisible(), true);
    assert.equal(trays.length, 1);
  });

  await t.test('has exactly one glyph and never swaps it', () => {
    // Codex's item has no active/idle artwork pair: `CUAServiceStatusItemView`
    // renders one image, and its only visual state is `isPressed` — which macOS
    // already draws behind a status item without being asked.
    const { item, trays, images } = makeItem();
    item.noteSessionActive('s1');
    item.noteSessionApp('s1', 'Safari');
    item.noteSessionActive('s1');
    item.noteSessionActive('s2');
    assert.equal(images.length, 1, 'one image, loaded once');
    assert.deepEqual(trays[0]!.images, ['cu-status'], 'set at creation, never again');
  });

  await t.test('sets no tooltip', () => {
    // Codex sets neither a tooltip nor an accessibility label on this item.
    const { item, trays } = makeItem();
    item.noteSessionActive('s1');
    item.noteSessionApp('s1', 'Safari');
    assert.deepEqual(trays[0]!.tooltips, []);
  });

  await t.test('reuses one tray across a burst of actions', () => {
    // A task is many actions. Creating and destroying a menu bar item per action
    // would make it flicker through exactly the work it is meant to report.
    const { item, trays } = makeItem();
    item.noteSessionActive('s1');
    item.noteSessionActive('s1');
    item.noteSessionActive('s1');
    assert.equal(trays.length, 1);
    assert.equal(trays[0]!.menus.length, 1, 'a repeat action changes nothing to rebuild');
  });

  await t.test('stays visible between actions with no timer to expire', () => {
    // The predecessor flipped to a dimmer glyph 2.5s after the last action, so
    // the item reported the age of an event. Visibility follows session count.
    const { item, trays } = makeItem();
    item.noteSessionActive('s1');
    assert.equal(item.isVisible(), true);
    assert.equal(trays[0]!.destroyed, false);
  });

  await t.test('shows one row per live session, in start order', () => {
    const { item, trays } = makeItem({ onStopRequested: () => {} });
    item.noteSessionActive('s1');
    item.noteSessionApp('s1', 'Safari');
    item.noteSessionActive('s2');
    item.noteSessionApp('s2', 'Notes');
    assert.deepEqual(labels(trays[0]), ['Stop Using Safari', 'Stop Using Notes']);
  });

  await t.test('numbers rows when one app is driven by two sessions', () => {
    const { item, trays } = makeItem({ onStopRequested: () => {} });
    item.noteSessionActive('s1');
    item.noteSessionApp('s1', 'Safari');
    item.noteSessionActive('s2');
    item.noteSessionApp('s2', 'Safari');
    assert.deepEqual(labels(trays[0]), ['Stop Using Safari (1)', 'Stop Using Safari (2)']);
  });

  await t.test('says only what it knows before the app is named', () => {
    // The item appears when an action begins; the window that action landed on
    // is only reported when it ends. Naming an app we have not observed yet
    // would be a guess.
    const { item, trays } = makeItem({ onStopRequested: () => {} });
    item.noteSessionActive('s1');
    assert.deepEqual(labels(trays[0]), ['Stop Computer Use']);
    item.noteSessionApp('s1', 'Safari');
    assert.deepEqual(labels(trays[0]), ['Stop Using Safari']);
  });

  await t.test('treats a pid fallback as no name at all', () => {
    // The backend identifies a nameless window as `pid:1234`. Correct, and a
    // terrible thing to read in a menu bar.
    const { item, trays } = makeItem({ onStopRequested: () => {} });
    item.noteSessionActive('s1');
    item.noteSessionApp('s1', 'pid:4821');
    assert.deepEqual(labels(trays[0]), ['Stop Computer Use']);
  });

  await t.test('speaks the language the rest of the app speaks', () => {
    // These three rows were English literals in an app that resolves a UI
    // locale at boot, and whose picture-in-picture sibling labels the same two
    // actions in Chinese — so the menu bar and the mirror disagreed about what
    // language the product speaks, on the same machine, at the same moment.
    const locale = { value: 'zh' as 'zh' | 'en' };
    const { item, trays } = makeItem({
      onStopRequested: () => {},
      resolveLocale: () => locale.value,
    });
    item.noteSessionActive('s1');
    assert.deepEqual(labels(trays[0]), ['停止 Computer Use']);
    item.noteSessionApp('s1', 'Safari');
    assert.deepEqual(labels(trays[0]), ['停止操作 Safari']);
    // A pid fallback is still no name, in either language.
    item.noteSessionActive('s2');
    item.noteSessionApp('s2', 'pid:4821');
    assert.deepEqual(labels(trays[0]), ['停止操作 Safari', '停止 Computer Use']);

    // Read on every rebuild, not captured once: changing the language in
    // Settings has to show up without relaunching the app.
    locale.value = 'en';
    item.noteSessionActive('s3');
    assert.deepEqual(labels(trays[0]), [
      'Stop Using Safari',
      'Stop Computer Use (1)',
      'Stop Computer Use (2)',
    ]);
  });

  await t.test('every row stops the session it names', () => {
    const stopped: string[] = [];
    const { item, trays } = makeItem({ onStopRequested: (id) => stopped.push(id) });
    item.noteSessionActive('session-a');
    item.noteSessionApp('session-a', 'Safari');
    item.noteSessionActive('session-b');
    item.noteSessionApp('session-b', 'Notes');
    rows(trays[0]).find((entry) => /Notes/.test(entry.label ?? ''))?.click?.();
    rows(trays[0]).find((entry) => /Safari/.test(entry.label ?? ''))?.click?.();
    assert.deepEqual(stopped, ['session-b', 'session-a']);
  });

  await t.test('a stop handler installed after construction still reaches the menu', () => {
    // The stop path is assembled with the session IPC, later than the tool
    // surface that owns this item, so the handler necessarily arrives late.
    const stopped: string[] = [];
    const { item, trays } = makeItem();
    item.noteSessionActive('s1');
    assert.equal(rows(trays[0])[0]?.enabled, false, 'nothing to stop with yet');

    item.setStopHandler((id) => stopped.push(id));
    assert.equal(rows(trays[0])[0]?.enabled, true);
    rows(trays[0])[0]?.click?.();
    assert.deepEqual(stopped, ['s1']);
  });

  await t.test('hides only when the last session ends', () => {
    // Codex: `statusItem.isVisible = (sessions.count != 0)`.
    const { item, trays } = makeItem({ onStopRequested: () => {} });
    item.noteSessionActive('s1');
    item.noteSessionApp('s1', 'Safari');
    item.noteSessionActive('s2');
    item.noteSessionApp('s2', 'Notes');

    item.clearForSession('s1');
    assert.equal(item.isVisible(), true, 'one session is still driving');
    assert.deepEqual(labels(trays[0]), ['Stop Using Notes']);

    item.clearForSession('s2');
    assert.equal(item.isVisible(), false);
    assert.equal(trays[0]!.destroyed, true);
  });

  await t.test('ignores a session that was never live', () => {
    const { item } = makeItem();
    item.noteSessionActive('s1');
    item.clearForSession('s2');
    assert.equal(item.isVisible(), true);
  });

  await t.test('destroy tears the tray down', () => {
    const { item, trays } = makeItem();
    item.noteSessionActive('s1');
    item.destroy();
    assert.equal(item.isVisible(), false);
    assert.equal(trays[0]!.destroyed, true);
  });

  await t.test('comes back after the last session ends', () => {
    const { item, trays } = makeItem();
    item.noteSessionActive('s1');
    item.clearForSession('s1');
    item.noteSessionActive('s2');
    assert.equal(item.isVisible(), true);
    assert.equal(trays.length, 2, 'a fresh tray, since the first was destroyed');
    assert.deepEqual(trays[1]!.images, ['cu-status']);
  });

  await t.test('ignores a blank session id', () => {
    const { item, trays } = makeItem();
    item.noteSessionActive('');
    assert.equal(item.isVisible(), false);
    assert.equal(trays.length, 0);
  });
});

test('status item wiring into the overlay hook', async (t) => {
  function fakeStatusItem() {
    const active: string[] = [];
    const apps: Array<[string, string | undefined]> = [];
    return {
      active,
      apps,
      item: {
        noteSessionActive: (id: string) => active.push(id),
        noteSessionApp: (id: string, app: string | undefined) => apps.push([id, app]),
        setStopHandler: () => {},
        clearForSession: () => {},
        destroy: () => {},
        isVisible: () => false,
      },
    };
  }

  await t.test('marks the session live for every action the hook sees', () => {
    // Load-bearing: the cursor declines to draw whenever the target window is
    // covered, which is most of the time during background work. Those are
    // precisely the actions the user needs told about, so the status item must
    // be driven by the hook itself rather than by whether the cursor drew.
    const { active, item } = fakeStatusItem();
    let innerCalls = 0;
    const hook = {
      onActionBegin: () => {
        innerCalls += 1;
        return undefined;
      },
    };
    const wrapped = withComputerUseStatusItem(hook as never, item);
    wrapped.onActionBegin({ type: 'left_click', coordinate: { x: 1, y: 1 } }, {
      sessionId: 's1',
      toolCallId: 't1',
    });
    assert.deepEqual(active, ['s1']);
    assert.equal(innerCalls, 1, 'the underlying cursor hook still runs');
  });

  await t.test('takes the app name from the observation the action landed on', () => {
    // The hook context carries only the session id, but a completed action
    // reports the window it acted on — which is how the menu can name the app
    // without new plumbing through the runtime.
    const { apps, item } = fakeStatusItem();
    const wrapped = withComputerUseStatusItem({ onActionBegin: () => undefined } as never, item);
    wrapped.onActionEnd?.(
      { type: 'left_click', coordinate: { x: 1, y: 1 } },
      {
        outcome: { ok: true, tier: 'ax' },
        observation: { observationId: 'o1', appId: 'Safari', pid: 1, windowId: 2, elements: [] },
      } as never,
      { sessionId: 's1', toolCallId: 't1' },
    );
    assert.deepEqual(apps, [['s1', 'Safari']]);
  });

  await t.test('survives a hook with no onActionEnd, and a failed action', () => {
    const { apps, item } = fakeStatusItem();
    const wrapped = withComputerUseStatusItem({ onActionBegin: () => undefined } as never, item);
    wrapped.onActionEnd?.({ type: 'screenshot' }, undefined, {
      sessionId: 's1',
      toolCallId: 't1',
    });
    assert.deepEqual(apps, [['s1', undefined]], 'reported as unknown, not invented');
  });

  await t.test('still runs the inner onActionEnd', () => {
    const { item } = fakeStatusItem();
    let innerEnds = 0;
    const wrapped = withComputerUseStatusItem(
      { onActionBegin: () => undefined, onActionEnd: () => { innerEnds += 1; } } as never,
      item,
    );
    wrapped.onActionEnd?.({ type: 'screenshot' }, undefined, { sessionId: 's1', toolCallId: 't1' });
    assert.equal(innerEnds, 1);
  });
});

test('Computer Use status item reports when anything is driving the machine', async (t) => {
  // The power assertion rides on this: the interval the item is visible for is
  // exactly the interval the system must not suspend for.
  await t.test('reports live on the first session and idle on the last', () => {
    const live: boolean[] = [];
    const { item } = makeItem({ onLiveChanged: (value) => live.push(value) });

    item.noteSessionActive('s1');
    item.noteSessionActive('s2');
    assert.deepEqual(live, [true], 'the second session does not make it more live');

    item.clearForSession('s1');
    assert.deepEqual(live, [true], 'still driving something');

    item.clearForSession('s2');
    assert.deepEqual(live, [true, false]);
  });

  await t.test('a repeated action on a live session reports nothing', () => {
    const live: boolean[] = [];
    const { item } = makeItem({ onLiveChanged: (value) => live.push(value) });
    item.noteSessionActive('s1');
    item.noteSessionActive('s1');
    assert.deepEqual(live, [true]);
  });

  await t.test('clearing a session that was never live reports nothing', () => {
    const live: boolean[] = [];
    const { item } = makeItem({ onLiveChanged: (value) => live.push(value) });
    item.clearForSession('never-started');
    assert.deepEqual(live, []);
  });

  await t.test('destroy releases a live item, and does not double-release', () => {
    const live: boolean[] = [];
    const { item } = makeItem({ onLiveChanged: (value) => live.push(value) });
    item.noteSessionActive('s1');
    item.destroy();
    assert.deepEqual(live, [true, false]);
    item.destroy();
    assert.deepEqual(live, [true, false]);
  });
});
