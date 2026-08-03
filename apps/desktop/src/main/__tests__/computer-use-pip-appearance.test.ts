/**
 * What the Computer Use mirror looks like.
 *
 * Reported from a screenshot: a stray white L in one corner, two buttons
 * crowding the picture, and a bare blue dot standing in for the cursor. The
 * values behind those, and the ones recovered from Codex that replace them,
 * are asserted here as values — not as strings that happen to appear in the
 * file — so that reverting any single one of them fails.
 */

import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, it, test } from 'node:test';
import { CODEX_CURSOR_GLYPH } from '../../renderer/computer-use-overlay/engine/cursor-engine.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DESKTOP = resolve(HERE, '..', '..', '..');
const PIP_HTML = resolve(DESKTOP, 'src', 'overlay', 'pip.html');
/** Built by `build:overlay`, which `build:test` runs before `test:dist`. */
const PIP_BUNDLE = resolve(DESKTOP, 'dist', 'overlay', 'pip.js');

/** The page's stylesheet, comments removed. */
async function styleSheet(): Promise<string> {
  const html = await readFile(PIP_HTML, 'utf8');
  const style = /<style>([\s\S]*?)<\/style>/.exec(html);
  assert.ok(style, 'the page has a stylesheet');
  return style[1].replace(/\/\*[\s\S]*?\*\//g, '');
}

/** The body of the block a selector opens, brace-balanced. */
function block(css: string, opener: string): string {
  const at = css.indexOf(opener);
  assert.notEqual(at, -1, `${opener} is in the stylesheet`);
  let depth = 0;
  for (let i = css.indexOf('{', at); i < css.length; i += 1) {
    if (css[i] === '{') depth += 1;
    else if (css[i] === '}') {
      depth -= 1;
      if (depth === 0) return css.slice(css.indexOf('{', at) + 1, i);
    }
  }
  throw new Error(`${opener} is never closed`);
}

/** One declared value out of a rule body, whitespace collapsed. */
function declaration(body: string, property: string): string {
  const found = new RegExp(`(?:^|[;{])\\s*${property}\\s*:([^;]*)`).exec(body);
  assert.ok(found, `${property} is declared`);
  return found[1].trim().replace(/\s+/g, ' ');
}

describe('Computer Use mirror appearance', () => {
  it('draws the tile square, the way Codex draws it', async () => {
    // Codex's container layer sets `masksToBounds` and a clear background and
    // never calls `setCornerRadius:`; none of that selector's call sites lands
    // in the mirror renderer. The 8px this replaces was Maka's own habit.
    const css = await styleSheet();
    const radius = declaration(block(css, '#shell {'), 'border-radius');
    assert.equal(Number.parseFloat(radius), 0);
  });

  it('shows a loading checkerboard before the first frame, not a flat fill', async () => {
    // 48pt squares, `((x / 48) + (y / 48)) % colors.count`, in the colourway
    // that is reachable unconditionally: rgb(0.05, 0.34, 0.84) under
    // rgb(0.09, 0.62, 0.95). Without this the pre-stream tile is a dead
    // rectangle indistinguishable from a stalled run.
    const css = await styleSheet();
    const body = block(css, '#placeholder {');
    const base = [0.05, 0.34, 0.84].map((c) => Math.round(c * 255));
    const over = [0.09, 0.62, 0.95].map((c) => Math.round(c * 255));
    const declared = declaration(body, 'background-color').match(/\d+/g) ?? [];
    assert.deepEqual(declared.map(Number), base);

    const image = declaration(body, 'background-image');
    const stops = [...image.matchAll(/rgb\((\d+) (\d+) (\d+)\)/g)].map((m) => m.slice(1).map(Number));
    assert.ok(stops.length >= 2, 'the checker colour is painted');
    for (const stop of stops) assert.deepEqual(stop, over);

    // Two 45° gradients on a 96pt period, the second offset by half of it,
    // is a 48pt checkerboard.
    const size = declaration(body, 'background-size').match(/[\d.]+/g)?.map(Number) ?? [];
    assert.deepEqual(size, [96, 96]);
    const position = declaration(body, 'background-position').match(/-?[\d.]+/g)?.map(Number) ?? [];
    assert.deepEqual(position, [0, 0, 48, 48]);
    const angles = [...image.matchAll(/(\d+)deg/g)].map((m) => Number(m[1]));
    assert.deepEqual(angles, [45, 45]);
  });

  it('sweeps a light bar across the placeholder on Codex’s timing', async () => {
    // frame(-64, 0, 64, h) at white 0.55, with `position.x` animated from -64
    // to width + 64 over 1.6s, repeating forever. The layer's centre anchor
    // puts its left edge at -96 and width + 32.
    const css = await styleSheet();
    const bar = block(css, '#sweep {');
    assert.equal(Number.parseFloat(declaration(bar, 'width')), 64);
    const alpha = declaration(bar, 'background').match(/\/ ([\d.]+)/)?.[1];
    assert.equal(Number(alpha), 0.55);
    const animation = declaration(bar, 'animation');
    assert.equal(Number.parseFloat(/([\d.]+)s/.exec(animation)?.[1] ?? '0'), 1.6);
    assert.match(animation, /\binfinite\b/);

    const keyframes = block(css, '@keyframes pipSweep');
    assert.equal(Number.parseFloat(declaration(block(keyframes, 'from {'), 'left')), -96);
    const to = declaration(block(keyframes, 'to {'), 'left');
    assert.equal(to.replace(/\s+/g, ''), 'calc(100%+32px)');
  });

  it('draws the cursor as the native arrow on its hotspot, not as a dot', async () => {
    // Codex draws a 20 x 23pt cursor with hotspot (4, 4) whatever the source
    // window measures — a tenth of the tile's edge at the 200pt default, so
    // the glyph is not the few pixels of noise the dot was chosen over.
    const html = await readFile(PIP_HTML, 'utf8');
    const css = await styleSheet();
    const box = block(css, '#cursor {');
    assert.equal(Number.parseFloat(declaration(box, 'width')), 20);
    assert.equal(Number.parseFloat(declaration(box, 'height')), 23);
    // The hotspot lands on the mapped point: the box is pulled back by it.
    const margin = declaration(box, 'margin').match(/-?[\d.]+/g)?.map(Number) ?? [];
    assert.deepEqual(margin, [-4, 0, 0, -4]);
    // Nothing round is left: no radius, no dot variable.
    assert.equal(/border-radius/.test(box), false);
    assert.equal(/--dot/.test(css), false);

    const path = /<path d="([^"]+)"/.exec(html);
    assert.ok(path, 'the cursor has a path');
    const drawn = (path[1].match(/-?[\d.]+/g) ?? []).map(Number);

    // The same AgentCursor path the on-screen cursor draws, on a 16pt frame
    // offset by the hotspot — which is also what puts the arrow's tip at
    // (4, 4), the two recoveries agreeing without being fitted to each other.
    const g = CODEX_CURSOR_GLYPH;
    const at = ([x, y]: readonly [number, number]) => [4 + x * 16, 4 + y * 16];
    const expected = [
      at(g.start),
      at(g.curve1[1]),
      at(g.curve1[2]),
      at(g.curve1[0]),
      at(g.line1),
      at(g.curve2[1]),
      at(g.curve2[2]),
      at(g.curve2[0]),
      at(g.line2),
      at(g.line3),
      at(g.curve3[1]),
      at(g.curve3[2]),
      at(g.curve3[0]),
    ].flat();
    assert.equal(drawn.length, expected.length);
    for (const [i, value] of expected.entries()) {
      assert.ok(
        Math.abs(drawn[i] - value) < 1e-3,
        `point ${i} is ${drawn[i]}, the glyph puts it at ${value}`,
      );
    }

    // The white rim is what keeps a small dark glyph readable over arbitrary
    // imagery, the same reading the on-screen cursor is drawn with.
    const paint = block(css, '#cursor path {');
    assert.equal(Number(declaration(paint, 'stroke').match(/\/ ([\d.]+)/)?.[1]), 0.8);
    assert.equal(Number.parseFloat(declaration(paint, 'stroke-width')), 2);
    assert.equal(declaration(paint, 'stroke-linejoin'), 'miter');
    assert.equal(Number.parseFloat(declaration(paint, 'stroke-miterlimit')), 10);
  });

  it('separates the controls from the picture instead of sitting on it', async () => {
    // Two 20pt buttons straight on the mirrored window had no edge of their
    // own against light content. A gradient scrim, not a backdrop filter:
    // over moving arbitrary imagery the filter is the expensive half.
    const css = await styleSheet();
    const scrim = block(css, '#chrome {');
    assert.ok(Number.parseFloat(declaration(scrim, 'height')) > 0);
    const gradient = declaration(scrim, 'background');
    const alphas = [...gradient.matchAll(/\/ ([\d.]+)\)/g)].map((m) => Number(m[1]));
    assert.deepEqual(alphas, [0.45, 0]);
    assert.equal(/backdrop-filter/.test(css), false);
    assert.equal(Number.parseFloat(declaration(block(css, '#chrome {'), 'opacity')), 0);
    assert.equal(
      Number.parseFloat(declaration(block(css, "#chrome[data-visible='1'] {"), 'opacity')),
      1,
    );
    // The controls stand off the corner far enough to read as chrome.
    const controls = block(css, '#controls {');
    assert.ok(Number.parseFloat(declaration(controls, 'top')) >= 8);
    assert.ok(Number.parseFloat(declaration(controls, 'right')) >= 8);
  });

  it('gives the resize grip the controls’ chip so it is not a stray mark', async () => {
    // Two hairlines drawn straight onto the picture were read as a white L
    // left over from something else. The buttons' scrim says it belongs to
    // the same set, and the shared inset says so again.
    const css = await styleSheet();
    const grip = block(css, '#resize {');
    const button = block(css, '#controls button {');
    assert.equal(declaration(grip, 'background'), declaration(button, 'background'));
    assert.equal(declaration(grip, 'box-shadow'), declaration(button, 'box-shadow'));
    assert.equal(
      Number.parseFloat(declaration(grip, 'left')),
      Number.parseFloat(declaration(block(css, '#controls {'), 'right')),
    );
    assert.equal(declaration(grip, 'cursor'), 'nwse-resize');
  });

  it('moves the grip to the corner opposite whichever anchor main sends down', async () => {
    // The gesture's sign follows the anchor (pipResizeEdge), so the handle has
    // to as well. The CSS used to hard-code `left: 8px; top: 8px` — the corner
    // opposite the default bottom-right anchor and wrong in the other three.
    // Anchored top-left, the grip sat on the pinned corner: dragging it grew
    // the tile from the far edge while the handle could not move, so the
    // pointer came off it on the first pixel.
    const css = await styleSheet();
    // Every corner the mirror can rest on has a rule, keyed on the attribute
    // the page sets from `pip:layout`.
    const corners = {
      // The bare rule is the default: opposite bottom-right.
      'top-left': block(css, '#resize {'),
      'top-right': block(css, "body[data-grip='top-right'] #resize {"),
      'bottom-left': block(css, "body[data-grip='bottom-left'] #resize {"),
      'bottom-right': block(css, "body[data-grip='bottom-right'] #resize {"),
    } as const;
    for (const [corner, rule] of Object.entries(corners)) {
      const [vertical, horizontal] = corner.split('-');
      // The inset the corner names is the one that is set; the other is auto,
      // because a stale `left` beats a new `right` and the chip would stay.
      assert.equal(Number.parseFloat(declaration(rule, vertical)), 8, `${corner}: ${vertical}`);
      assert.equal(Number.parseFloat(declaration(rule, horizontal)), 8, `${corner}: ${horizontal}`);
      const oppositeV = vertical === 'top' ? 'bottom' : 'top';
      const oppositeH = horizontal === 'left' ? 'right' : 'left';
      if (rule !== corners['top-left']) {
        assert.equal(declaration(rule, oppositeV), 'auto', `${corner}: ${oppositeV}`);
        assert.equal(declaration(rule, oppositeH), 'auto', `${corner}: ${oppositeH}`);
      }
      // A grip on the ↖↘ diagonal points that way; the other two are ↗↙.
      const diagonal = corner === 'top-left' || corner === 'bottom-right';
      assert.equal(
        declaration(rule, 'cursor'),
        diagonal ? 'nwse-resize' : 'nesw-resize',
        `${corner}: cursor`,
      );
    }
    // The controls own the top-right, so they move when the grip is sent there.
    const moved = block(css, "body[data-grip='top-right'] #controls {");
    assert.equal(declaration(moved, 'right'), 'auto');
    assert.equal(Number.parseFloat(declaration(moved, 'left')), 8);
  });
});

// ── the page, running ────────────────────────────────────────────────────────

type Stub = {
  dataset: Record<string, string>;
  style: Record<string, string> & { setProperty(name: string, value: string): void };
  clientWidth: number;
  clientHeight: number;
  src: string;
  addEventListener(): void;
};

function element(): Stub {
  const style = {
    setProperty(this: Record<string, string>, name: string, value: string) {
      this[name] = value;
    },
  } as Stub['style'];
  return {
    dataset: {},
    style,
    clientWidth: 0,
    clientHeight: 0,
    src: '',
    addEventListener() {},
    classList: { add() {} },
  } as unknown as Stub;
}

type Bridge = {
  frame(payload: unknown): void;
  cursor(payload: unknown): void;
  controls(payload: unknown): void;
  layout(payload: unknown): void;
};

/** Load the built page against a stub DOM and hand back its inputs. */
let loads = 0;
async function loadPage(): Promise<{ nodes: Record<string, Stub>; body: Stub; send: Bridge }> {
  const nodes: Record<string, Stub> = {};
  for (const id of ['frame', 'cursor', 'placeholder', 'chrome', 'controls', 'resize']) {
    nodes[id] = element();
  }
  const handlers: Record<string, (payload?: unknown) => void> = {};
  const bridge = {
    onFrame: (cb: (p: unknown) => void) => {
      handlers.frame = cb;
    },
    onCursor: (cb: (p: unknown) => void) => {
      handlers.cursor = cb;
    },
    onControls: (cb: (p: unknown) => void) => {
      handlers.controls = cb;
    },
    onLayout: (cb: (p: unknown) => void) => {
      handlers.layout = cb;
    },
    onCompleted: (cb: () => void) => {
      handlers.completed = cb;
    },
    send: () => {},
  };
  const body = element();
  const globals = globalThis as unknown as Record<string, unknown>;
  globals.document = {
    getElementById: (id: string) => nodes[id] ?? null,
    addEventListener: () => {},
    body,
  };
  globals.window = { addEventListener: () => {}, computerUsePip: bridge };
  // A fresh copy per call. The bundle registers its handlers as a side effect
  // of being evaluated, and a plain re-import is served from the module cache:
  // the second caller would get its bridge back untouched and every handler
  // undefined.
  loads += 1;
  await import(`${pathToFileURL(PIP_BUNDLE).href}?load=${loads}`);
  return {
    nodes,
    body,
    send: {
      frame: (p) => handlers.frame(p),
      cursor: (p) => handlers.cursor(p),
      controls: (p) => handlers.controls(p),
      layout: (p) => handlers.layout(p),
    },
  };
}

test('the placeholder comes down when the stream starts, and the chrome moves with the controls', async () => {
  const { nodes, send } = await loadPage();

  // The mirror is letterboxed, so the cursor's position in capture pixels is
  // not its position in the element. This is the mapping the arrow inherited
  // from the dot unchanged; it is asserted here so the redraw cannot move it.
  nodes.frame.clientWidth = 200;
  nodes.frame.clientHeight = 200;
  send.frame({ src: 'data:image/png;base64,x', widthPx: 400, heightPx: 300 });
  assert.equal(nodes.placeholder.dataset.visible, '0');
  assert.equal(nodes.frame.src, 'data:image/png;base64,x');

  send.cursor({ x: 200, y: 150 });
  assert.equal(nodes.cursor.style.left, '100px');
  assert.equal(nodes.cursor.style.top, '100px');
  assert.equal(nodes.cursor.dataset.visible, '1');
  // Nothing sizes the cursor from JS any more; it is a fixed 20 x 23 box.
  assert.equal(nodes.cursor.style['--dot'], undefined);

  send.controls({ visible: true });
  assert.equal(nodes.chrome.dataset.visible, '1');
  assert.equal(nodes.controls.dataset.visible, '1');
  assert.equal(nodes.resize.dataset.visible, '1');
  send.controls({ visible: false });
  assert.equal(nodes.chrome.dataset.visible, '0');
});

test('the page moves the grip to whichever corner main names', async () => {
  // The CSS can only follow the anchor if the page is told what the anchor is,
  // and before `pip:layout` nothing sent it: `grep alignment src/overlay/`
  // returned nothing at all, so the grip was frozen on the tile's top-left.
  const { body, send } = await loadPage();

  send.layout({ alignment: 'top-left', gripCorner: 'bottom-right' });
  assert.equal(body.dataset.grip, 'bottom-right');
  send.layout({ alignment: 'bottom-left', gripCorner: 'top-right' });
  assert.equal(body.dataset.grip, 'top-right');

  // Anything the page does not recognise leaves the grip where it is, rather
  // than clearing the attribute and dropping the tile back to the default
  // corner while it is anchored somewhere else.
  send.layout({ alignment: 'top-left', gripCorner: 'middle' });
  assert.equal(body.dataset.grip, 'top-right');
  send.layout(null);
  assert.equal(body.dataset.grip, 'top-right');
});
