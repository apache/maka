import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  editableElementAtScreenPoint,
  elementAtScreenPoint,
  resolveWindowAtDeclaredPoint,
  windowPointFromSnapshot,
  withoutMenuBar,
} from '../cua-driver-snapshot.js';

describe('cua-driver snapshot coordinate authority', () => {
  const windows = [
    {
      window_id: 11,
      pid: 101,
      app_name: 'Alpha',
      title: 'Alpha Window',
      layer: 0,
      is_on_screen: true,
      z_index: 2,
      bounds: { x: 100, y: 50, width: 500, height: 400 },
    },
    {
      window_id: 12,
      pid: 102,
      app_name: 'Beta',
      title: 'Beta Window',
      layer: 0,
      is_on_screen: true,
      z_index: 9,
      bounds: { x: 200, y: 100, width: 300, height: 250 },
    },
    {
      window_id: 13,
      pid: 103,
      layer: 3,
      is_on_screen: true,
      z_index: 99,
      bounds: { x: 0, y: 0, width: 800, height: 600 },
    },
  ];

  it('resolves declared desktop pixels to the highest-z eligible logical window', () => {
    const target = resolveWindowAtDeclaredPoint({
      declaredPoint: { x: 600, y: 400 },
      desktopFrameWidthPx: 3024,
      logicalDisplayWidth: 1512,
      windows,
    });

    assert.ok(target);
    assert.equal(target.pid, 102);
    assert.equal(target.windowId, 12);
    assert.equal(target.appName, 'Beta');
    assert.equal(target.title, 'Beta Window');
    assert.deepEqual(target.screenPoint, { x: 300, y: 200 });
  });

  it('maps logical screen point into the same snapshot screenshot pixel space', () => {
    const point = windowPointFromSnapshot({
      screenPoint: { x: 350, y: 250 },
      windowBounds: { x: 100, y: 50, width: 500, height: 400 },
      screenshotWidthPx: 1000,
      screenshotHeightPx: 800,
    });

    assert.deepEqual(point, { x: 500, y: 400 });
  });

  it('rejects malformed or out-of-bounds window snapshot transforms', () => {
    assert.equal(
      windowPointFromSnapshot({
        screenPoint: { x: 99, y: 100 },
        windowBounds: { x: 100, y: 50, width: 500, height: 400 },
        screenshotWidthPx: 1000,
        screenshotHeightPx: 800,
      }),
      undefined,
    );
    assert.equal(
      windowPointFromSnapshot({
        screenPoint: { x: 200, y: 100 },
        windowBounds: { x: 100, y: 50, width: 0, height: 400 },
        screenshotWidthPx: 1000,
        screenshotHeightPx: 800,
      }),
      undefined,
    );
  });
});

describe('cua-driver AX hit testing', () => {
  const elements = [
    {
      element_index: 1,
      element_token: 'token-1',
      role: 'AXGroup',
      depth: 1,
      frame: { x: 100, y: 100, w: 400, h: 300 },
    },
    {
      element_index: 2,
      element_token: 'token-2',
      role: 'AXTextArea',
      depth: 4,
      frame: { x: 180, y: 160, w: 220, h: 120 },
    },
    {
      element_index: 3,
      element_token: 'token-3',
      role: 'AXButton',
      depth: 5,
      frame: { x: 190, y: 170, w: 80, h: 40 },
    },
    {
      element_index: 4,
      role: 'AXSecureTextField',
      depth: 3,
      frame: { x: 500, y: 100, w: 120, h: 30 },
    },
  ];

  it('chooses the smallest and deepest actionable element containing the point', () => {
    const element = elementAtScreenPoint(elements, { x: 210, y: 190 });
    assert.equal(element?.element_index, 3);
    assert.equal(element?.element_token, 'token-3');
  });

  it('does not send generic groups or editable fields through AXPress', () => {
    assert.equal(elementAtScreenPoint(elements, { x: 350, y: 250 }), undefined);
  });

  it('chooses an editable element separately from a nested non-editable control', () => {
    const element = editableElementAtScreenPoint(elements, { x: 210, y: 190 });
    assert.equal(element?.element_index, 2);
  });

  it('does not select secure text fields for automated keyboard input', () => {
    assert.equal(editableElementAtScreenPoint(elements, { x: 520, y: 110 }), undefined);
  });
});

describe('cua-driver menu bar exclusion', () => {
  const node = (index: number, role: string, parent?: number) => ({
    element_index: index,
    role,
    ...(parent === undefined ? {} : { parent_index: parent }),
    frame: { x: 0, y: 0, w: 10, h: 10 },
  });

  it('drops the menu bar, which belongs to the app and not the window', () => {
    // `get_window_state` walks the app, so an app's menu bar arrives with its
    // window. Once macOS has built the menu item tree that is enormous:
    // measured on Calculator, a 500-element budget came back as 474 elements
    // of which every single one was a menu, and the window's own 34 controls
    // were nowhere in the answer. Nothing told the model the tree had been cut.
    const kept = withoutMenuBar([
      node(0, 'AXMenuBar'),
      node(1, 'AXMenuBarItem', 0),
      node(2, 'AXMenu', 1),
      node(3, 'AXMenuItem', 2),
      node(4, 'AXWindow'),
      node(5, 'AXButton', 4),
    ]);
    assert.deepEqual(
      kept.map((element) => String(element.role)),
      ['AXWindow', 'AXButton'],
    );
  });

  it('drops what hangs off a menu even when the role is not a menu role', () => {
    // A menu item may contain anything — a custom view, an image, a slider.
    // Filtering on role alone would keep those and leave the model holding
    // fragments of a menu it cannot see the shape of.
    const kept = withoutMenuBar([
      node(0, 'AXMenuBar'),
      node(1, 'AXMenuBarItem', 0),
      node(2, 'AXMenu', 1),
      node(3, 'AXMenuItem', 2),
      node(4, 'AXSlider', 3),
      node(5, 'AXGroup', 4),
      node(6, 'AXWindow'),
      node(7, 'AXSlider', 6),
    ]);
    assert.deepEqual(
      kept.map((element) => element.element_index),
      [6, 7],
      'the slider inside the menu goes; the one inside the window stays',
    );
  });

  it('keeps everything when there is no menu bar', () => {
    const elements = [node(0, 'AXWindow'), node(1, 'AXButton', 0)];
    assert.equal(withoutMenuBar(elements).length, 2);
  });
});
