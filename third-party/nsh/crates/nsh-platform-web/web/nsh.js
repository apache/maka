// The browser side of nsh's WebAssembly runtime (`nsh-platform-web`):
// loads `nsh.wasm`, runs an app bundle and mounts what the core commits as
// DOM elements. The core lays everything out, so every view is an
// absolutely positioned element at the frame it was given; this file only
// assigns frames and the CSS the Rust side made, draws text runs at their
// laid-out positions, and turns pointer, keyboard and scroll input into
// engine events.
//
//   const player = await createPlayer(container, { wasm: "nsh.wasm" });
//   await player.runModule("app.js");
//
// Apps run on the browser's own JavaScript engine, in a realm of their
// own (`browser/runtime.js`): `runModule` runs a module by URL,
// `runSource` one given as source text (the development host's bundles),
// `hotUpdate` applies the dev server's hot updates in place.
//
// Options: `wasm` (its URL, or a `Response` promise), `glue` (the URL of
// the wasm-bindgen glue of a runtime whose crates call JS through
// wasm-bindgen, which the CLI writes next to it; each player imports an
// instance of its own), `assetBase` (where `asset:/<path>` is served) or
// `assets` (a map from `<path>` to its URL, as `nsh package --target web`
// writes it; relative URLs, these and the others, resolve against the
// page's `document.baseURI` as the player is made, or `baseURL`:
// `player.baseURL`), `baseURL` (the site's base, which the app's relative
// URLs and addresses resolve against instead of the page's: a page served
// at its app's routes names it so, as a strict `base-uri` refuses a
// `<base href>`),
// `readAsset(uri)` (the bytes of an asset the engine needs at
// once, a font: a `Uint8Array` or null), `data` (the URLs of the files the
// runtime fetches when it first needs them, by name, as `nsh package
// --target web` writes them: `{ syntaxes: "nsh-syntaxes.<digest>.bin" }`;
// by default `nsh-<name>.bin` next to this file), `prepareChunk(id)` (a
// promise for what chunk `id` needs once it
// runs, such as fonts for `readAsset`; awaited with the chunk's download),
// `dark`, `idiom` ("phone", "pad" or "desktop" instead of the one the
// pointer and the viewport suggest), `dialogs` ("viewport": `Dialog`,
// `Sheet` and `AlertDialog` cover the whole window, in the browser's top layer, rather
// than the container, which they cover by default and in browsers without
// popovers), `overlay` (false: no error box), `onError`, `onLog`, `host`
// (the functions `nsh/host`'s `host.call(name, args)` reaches: an object
// whose `call(name, args)` returns the result or a promise of it; a throw
// or a rejection rejects the app's call; its optional `post(name, args)`
// takes the app's `host.post`, which goes to `call` without one, its result
// and failures dropped; without it `host.available()` is
// false). The page sends
// `host.on` listeners events with `player.hostEvent(event, payload)`
// (JSON; it throws when the payload is not); events sent before the app
// runs are delivered, in order, once it starts.
//
// A split bundle (`nsh build --split`) loads its chunks on demand: from
// `chunks[id]` when given (`app.<digest>.js` on a CDN), else `id` relative
// to the entry:
//
//   await player.runModule("app.js", { chunks: { "Screen.js": "/app.3f2a.js" } });

const ROOT_ID = 1;
const PRESSED = 1;
const HOVERED = 2;
const FOCUSED = 4;
/** `KeyboardEvent.key`s of modifiers: pressed alone, they leave the input
 * modality as it is (`inputWith`). */
const MODALITY_KEYS_SKIPPED = new Set(["Shift", "Control", "Alt", "AltGraph", "Meta", "CapsLock", "Fn", "Hyper", "Super", "OS"]);
const PRESS_EVENTS = ["onPress", "onLongPress", "onPressIn", "onPressOut"];
/** A view listening to one of these receives files dragged in from the system. */
const FILE_DROP_EVENTS = ["onFileDrop", "onFileDragEnter", "onFileDragLeave"];
/** The most files one drop reads, and the most bytes it reads in all (as `Picker.pickFiles`). */
const FILE_DROP_LIMIT = 100;
const FILE_DROP_MAX_BYTES = 512 * 1024 * 1024;
/** The press listeners other than `onLongPress`, which alone leaves the taps to the views around. */
const TAP_EVENTS = ["onPress", "onPressIn", "onPressOut"];
const MOUSE_EVENTS = ["onMouseEnter", "onMouseLeave", "onMouseMove"];
/** The DOM's `buttons` bits, in the order a held button is named by. */
const MOUSE_BUTTONS = [[1, "left"], [2, "right"], [4, "middle"], [8, "back"], [16, "forward"]];
/** The DOM's `button` numbers, in the order a released button is named by. */
const MOUSE_BUTTON_NAMES = ["left", "middle", "right", "back", "forward"];
/** The DOM's `buttons` bit of each `button` number. */
const MOUSE_BUTTON_BITS = [1, 4, 2, 8, 16];
/** The keys whose press or release is reported as a mouse move. */
const MOUSE_MODIFIER_KEYS = new Set(["Control", "Alt", "Shift", "Meta"]);
/** A link the browser can open itself: a `Link` with an `href`, drawn as an `a`. */
const LINK_SELECTOR = "a.nsh-v[href]";

/**
 * Whether pointer event `e` holds a modifier key. A click with one on a link
 * (`LINK_SELECTOR`) is the browser's, which opens the link in a new tab (Cmd
 * or Ctrl), a new window (Shift) or downloads it (Alt); a plain one is the
 * app's (`installInput`, `pointerDown`).
 */
function heldModifier(e) {
  return e.metaKey || e.ctrlKey || e.shiftKey || e.altKey;
}
// What lays out a field's text, copied to the hidden copy that finds its
// caret (`caretBounds`).
const CARET_STYLE = [
  "direction", "boxSizing", "width", "height", "borderTopWidth", "borderRightWidth", "borderBottomWidth",
  "borderLeftWidth", "borderStyle", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "fontStyle",
  "fontVariant", "fontWeight", "fontStretch", "fontSize", "lineHeight", "fontFamily", "textAlign",
  "textTransform", "textIndent", "letterSpacing", "wordSpacing", "tabSize",
];
/** `accessibilityRole`s whose ARIA role has another name; others are the same. */
const ARIA_ROLES = {
  none: null, header: "heading", image: "img", imagebutton: "button", keyboardkey: "button", adjustable: "slider",
  search: "searchbox", text: null, summary: "status", togglebutton: "button", dropdownlist: "combobox",
};

/** Reconcile accessibility props with the element's current attributes. */
function setAriaAttribute(el, name, value) {
  const next = value == null || value === false ? null : String(value);
  if (el.getAttribute(name) === next) return;
  if (next === null) el.removeAttribute(name);
  else el.setAttribute(name, next);
}

/** Elements a browser's Tab stops at without a `tabindex` (`elementTag`'s
 * links and `web={{ element }}` values). */
const NATIVE_STOPS = "a[href], button, input, select, textarea, summary, [contenteditable]";

/**
 * The HTML element a view or text is drawn as, from what its props say it
 * is: a heading (`role="header"`, `h1` to `h6` by `accessibilityLevel`,
 * `h2` without one, as ARIA's default), a link (`role="link"` with an
 * `href`, as `Link` sets), else the element `web={{ element }}` names, else
 * a `div`.
 */
export function elementTag(props) {
  if (props.element) return props.element;
  if (props.role === "header") return `h${Math.min(6, Math.max(1, props.level ?? 2))}`;
  if (props.role === "link" && props.href != null) return "a";
  return "div";
}

/** How far a refreshable scroll view is pulled to refresh, and the room its spinner takes while refreshing (as on Linux and macOS), unless the app draws its own indicator (`refreshIndicator`: its height is both). */
const REFRESH_PULL = 64;
const REFRESH_SPACE = 56;
/** Desktop scroll bars (`showBar`): thickness, margin, the band along the
 * edge a press grabs (points), and how long a shown bar stays (ms). */
const BAR_THICK = 4;
const BAR_MARGIN = 2;
const BAR_GRAB = 12;
const BAR_HOLD = 700;
/** How long (ms) an animated scroll command of the core's takes here, the
 * length its own animation runs for on the other platforms (`nsh-core`'s
 * `scroll::ANIMATION`, eased out cubically): the browser's
 * `behavior: "smooth"` takes about a second over a long distance, and
 * starts over every time a command retargets it, which a list does as it
 * measures the rows the scroll passes. */
const SCROLL_MS = 300;

/* Keyframe animations (animate-spin, -ping, -pulse, -bounce) run with
   animation-composition: add: their transforms follow the view's own (as the
   native backends apply them), and --nsh-ko is added to 1 to make the factor
   the view's opacity is multiplied by (opacity: calc(<opacity> * var(--nsh-ko))). */
/** Screen motion (the Linux backend's): a push or pop slides for SLIDE_MS
 * while the screen under it moves by PARALLAX of the width, a fade takes
 * FADE_MS, both easing out cubically (1 - (1 - t)^3, exactly). */
const SLIDE_MS = 300;
const FADE_MS = 200;
/** How long a back that popped pages waits for the app's answer (a page's
 * `onDismiss` follows its slide; an app's own motion may last longer)
 * before its address is the app's `change` (`settlePop`). */
const POP_ANSWER_MS = 1500;
const PARALLAX = 0.3;
const EASE_OUT_CUBIC = "cubic-bezier(0.333,1,0.667,1)";
// Browsers that order Tab and screen readers by `reading-order`
// (`orderReading`); the others keep the DOM's order.
const READING_ORDER = typeof CSS !== "undefined" && !!CSS.supports?.("reading-flow", "source-order");
/** How far back a pointer's velocity is measured (ms). */
const VELOCITY_WINDOW = 100;
/** How long after something animated comes due a timer makes it happen
 * when no animation frame did (`keepDeadline`, `moveScreens`, ...): more
 * than a frame, so that while the page shows its frames always come first. */
const LATE_MS = 50;
/** How long after its time a frame's `requestAnimationFrame` callbacks may
 * run and still step the native animations at that time (`frameTime`):
 * later than that, a task held the frame. */
const FRAME_HELD_MS = 16;
/** How long a dialog waits for the two frames before it comes in
 * (`present`): far more than two frames, so it only waits that long while
 * frames stop (a hidden tab). */
const ENTER_LATE_MS = 250;

/** View kinds whose frames, appearing and disappearing are navigation's. */
const NAVIGATED = new Set(["stack", "screen", "modal", "header", "accessory"]);

/** The status of an offscreen render's answer (`nsh_canvas_image`, `src/lib.rs`
 * `CanvasImageStatus`): the image's bytes, or a message why there are none. */
const CANVAS_IMAGE = { FAILED: 0, OK: 1, TOO_LARGE: 2 };

/** An offscreen render over the browser's canvas size limit
 * (`CANVAS_IMAGE.TOO_LARGE`). */
class CanvasTooLarge extends Error {}

function tooLarge(width, height) {
  return `this browser cannot make a ${width} × ${height} pixel canvas (${width * height} pixels): it is over the browser's canvas size limit`;
}

/** A listener that does nothing: a blocking `wheel` listener's presence. */
const noop = () => {};

/** Whether `src` is on the page's origin. */
function sameOrigin(src) {
  try {
    return new URL(src, location.href).origin === location.origin;
  } catch {
    return false;
  }
}

/** `logo@2x.png` → 2: the pixel density a file name declares, 1 without
 * (`nsh_core::image::loader::density`). */
function imageDensity(uri) {
  const name = String(uri).split(/[/\\]/).pop();
  const dot = name.lastIndexOf(".");
  const stem = dot < 0 ? name : name.slice(0, dot);
  const at = stem.lastIndexOf("@");
  if (at < 0 || !stem.endsWith("x")) return 1;
  const n = Number(stem.slice(at + 1, -1));
  return Number.isFinite(n) && n > 0 ? n : 1;
}

function originOf(src) {
  try {
    return new URL(src, location.href).origin;
  } catch {
    return src;
  }
}

const KEYFRAMES = `
@property --nsh-ko { syntax: "<number>"; inherits: false; initial-value: 1; }
@keyframes nsh-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
@keyframes nsh-ping { 0% { transform: scale(1); --nsh-ko: 0; } 75%, 100% { transform: scale(2); --nsh-ko: -1; } }
@keyframes nsh-pulse { 0%, 100% { --nsh-ko: 0; } 50% { --nsh-ko: -.5; } }
@keyframes nsh-bounce {
  0%, 100% { transform: translateY(-25%); animation-timing-function: cubic-bezier(0.8,0,1,1); }
  50% { transform: translateY(0); animation-timing-function: cubic-bezier(0,0,0.2,1); }
}
@keyframes nsh-spinner { to { transform: rotate(360deg); } }
/* Reduced motion: style transitions and keyframes do not run, as on the
   native backends. */
.nsh-reduce .nsh-v { transition: none !important; animation: none !important; }
/* Touches pan only scroll views (the page neither scrolls, zooms nor
   refreshes under the app, and pans and presses get no pointercancel);
   overflow is clipped, never hidden, so that the browser cannot scroll a
   box the core laid out to show a focused field. */
.nsh-root { position: relative; width: 100%; height: 100%; overflow: clip; -webkit-user-select: none; user-select: none;
  -webkit-font-smoothing: antialiased; -webkit-tap-highlight-color: transparent; -webkit-touch-callout: none;
  touch-action: none; }
.nsh-root * { box-sizing: border-box; }
.nsh-v { position: absolute; margin: 0; padding: 0; min-width: 0; min-height: 0; }
/* Views drawn as document elements (headings, links, \`web={{ element }}\`) look as a view does: none of
   the browser's margins, fonts, colors, underlines or list markers. */
:is(h1, h2, h3, h4, h5, h6, p, a, ul, ol, li, strong, em, blockquote, figure, figcaption, time, address, nav, header,
  footer, main, article, section, aside).nsh-v { display: block; font: inherit; color: inherit; text-decoration: none;
  list-style: none; }
/* The keyboard focus shows as the app draws it (focus: styles), as
   on the desktop backends: no ring of the browser's or the runtime's. */
.nsh-v:focus { outline: none; }
.nsh-scroll { overflow: auto; overscroll-behavior: contain; -webkit-overflow-scrolling: touch; }
.nsh-scroll { touch-action: pan-x pan-y; }
/* In an iframe, swipes the app does not take scroll the embedding page. */
.nsh-root.nsh-embedded { touch-action: pan-x pan-y; }
/* Views with native pans: none, or the other axis's scrolling. */
.nsh-pan { touch-action: none; }
.nsh-pan-x { touch-action: pan-y; }
.nsh-pan-y { touch-action: pan-x; }
/* A pan of one way leaves the other way to the browser where it can tell
   them apart (CSS's pan-right scrolls right: the finger moves left), else
   the other axis only. */
.nsh-pan-right { touch-action: pan-y; touch-action: pan-right pan-y; }
.nsh-pan-left { touch-action: pan-y; touch-action: pan-left pan-y; }
.nsh-pan-down { touch-action: pan-x; touch-action: pan-x pan-down; }
.nsh-pan-up { touch-action: pan-x; touch-action: pan-x pan-up; }
.nsh-live { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
/* Scroll indicators: a thin, translucent thumb with no track, as on phones,
   rather than the platform's scrollbar (with arrow buttons on Windows).
   Chromium ignores the pseudo-elements once scrollbar-width / scrollbar-color
   are set, so those are only for browsers without them (Firefox). */
.nsh-scroll::-webkit-scrollbar { width: 6px; height: 6px; }
.nsh-scroll::-webkit-scrollbar-track, .nsh-scroll::-webkit-scrollbar-corner { background: transparent; }
.nsh-scroll::-webkit-scrollbar-track:vertical { margin: var(--nsh-bar-t, 0) 0 var(--nsh-bar-b, 0); }
.nsh-scroll::-webkit-scrollbar-track:horizontal { margin: 0 var(--nsh-bar-r, 0) 0 var(--nsh-bar-l, 0); }
.nsh-scroll::-webkit-scrollbar-thumb { border-radius: 3px; background: rgba(128,128,128,.45); }
@supports not selector(::-webkit-scrollbar) {
  .nsh-scroll { scrollbar-width: thin; scrollbar-color: rgba(128,128,128,.45) transparent; }
}
.nsh-noindicator { scrollbar-width: none; }
.nsh-noindicator::-webkit-scrollbar { display: none; }
/* In the desktop idiom nsh draws the scroll bars (showBar) over the
   content, as the desktop backends do: the browser's would take room from
   content laid out for the whole view. The bar is sticky at the scroll
   view's top left, so it stays in place as the content scrolls. */
.nsh-desktop .nsh-scroll { scrollbar-width: none; }
.nsh-desktop .nsh-scroll::-webkit-scrollbar { display: none; }
.nsh-bar { position: sticky; left: 0; top: 0; width: 0; height: 0; z-index: 2147483000; pointer-events: none; }
.nsh-bar > div { position: absolute; border-radius: 2px; background: rgba(0,0,0,.45); transition: opacity .3s; }
.nsh-dark .nsh-bar > div { background: rgba(255,255,255,.55); }
/* Underlines unbroken, as the native backends draw them (skipping
   descenders left a link's "gp" without one), and clear of the text: a
   browser's auto position touches the baseline. A run's own
   textUnderlineOffset (its style class) replaces the offset. */
.nsh-run { position: absolute; white-space: pre; text-decoration-skip-ink: none;
  text-underline-offset: 0.2em; }
.nsh-run-bg { position: absolute; pointer-events: none; }
.nsh-border { position: absolute; inset: 0; pointer-events: none; }
/* A view of no size (\`display: none\` lays it out at none) draws nothing of
   its own, as on the native backends, which draw inside its bounds: CSS
   would still draw its border overlay (a border-box is never smaller than
   its borders, so four 1px borders make a 2px square), its outline and its
   shadow's spread. Its children stay, a zero-size anchor's included. */
.nsh-empty > .nsh-border { display: none; }
.nsh-v.nsh-empty { outline: none; box-shadow: none; }
/* The mounter's own styles: no element has an inline style but its frame
   and animated values (generated classes, \`op_css\`, come after these). */
.nsh-page { overscroll-behavior: none; }
.nsh-scheme-light { color-scheme: light; }
.nsh-scheme-dark { color-scheme: dark; }
.nsh-hidden { visibility: hidden; }
.nsh-gone { display: none; }
/* \`pointerEvents\`: "none" takes the whole subtree out; "box-none" the view only, its child views stay targets (its
   own layers, which take no pointer events, keep theirs). */
:where(.nsh-box-none > *) { pointer-events: auto; }
.nsh-box-none { pointer-events: none; }
.nsh-inert, .nsh-inert * { pointer-events: none !important; }
.nsh-clip { overflow: clip; }
/* Chromium drops the backdrop filters (or their masks) inside a view that clips with \`corner-shape\` corners
   (placeCorners): such a view with a backdrop-filtered view inside clips with circular corners of the radius. */
.nsh-curve-clip:has(.nsh-backdrop) { corner-shape: round !important; border-radius: var(--nsh-round) !important; }
/* A sticky list cell's range of travel (op_sticky): it lifts the cell above the other cells, and with no breadth
   across it takes no pointer events. The cell sticks inside it, at its left in either direction. */
.nsh-track { position: absolute; z-index: 5; }
.nsh-track > .nsh-v { position: sticky; margin-right: auto; }
/* A list with sticky cells keeps their z-index to itself: above its other cells, never over the views after it. */
.nsh-sticky { isolation: isolate; }
.nsh-fill { position: absolute; left: 0; top: 0; width: 100%; height: 100%; border: 0; }
img.nsh-fill { pointer-events: none; }
.nsh-shader { pointer-events: none; border-radius: inherit; }
/* A shader effect, a running shader transition, the root under a screen effect (op_sh): its children show through its
   shader's canvas over them; at opacity 0 they keep their pointer events. */
.nsh-fx > :not(.nsh-fx-out):not(.nsh-nav-shader) { opacity: 0 !important; }
/* Its canvas is over its children only: never over what comes after it, such as a dialog. */
.nsh-fx { isolation: isolate; }
.nsh-fx-out { pointer-events: none; z-index: 2147483000; }
/* While NSH paints an effect's children (paintInputs): shown at once, without a CSS transition from opacity 0. */
.nsh-painting, .nsh-painting * { transition: none !important; }
.nsh-fit-cover { object-fit: cover; }
.nsh-fit-contain { object-fit: contain; }
.nsh-fit-fill { object-fit: fill; }
.nsh-fit-scale-down { object-fit: scale-down; }
.nsh-fit-none { object-fit: none; }
.nsh-spacer { position: absolute; left: 0; top: 0; width: 1px; height: 1px; pointer-events: none; visibility: hidden; }
/* Over the style's \`overflow: clip\`. */
/* A one-axis scroll view keeps only its own axis's overscroll: a swipe
   across it (vertical over a horizontal one, as over an editor's text
   inside its vertical scroll) scrolls the scroll view around it. */
.nsh-scroll.nsh-ox.nsh-ox { overflow-x: auto; overflow-y: hidden; overscroll-behavior-y: auto; }
.nsh-scroll.nsh-oy.nsh-oy { overflow-x: hidden; overflow-y: auto; overscroll-behavior-x: auto; }
.nsh-scroll.nsh-oxy.nsh-oxy { overflow: auto; }
.nsh-scroll.nsh-onone.nsh-onone { overflow: hidden; }
/* A scroll view whose content fits along its axis has nothing to scroll
   (\`nsh-fits\`): a swipe along it scrolls the scroll view around it, as on
   Android, instead of stopping at its \`contain\` and moving nothing. */
.nsh-scroll.nsh-fits.nsh-fits { overscroll-behavior: auto; }
.nsh-scroll.nsh-zoom.nsh-zoom { touch-action: none; }
.nsh-snap-x { scroll-snap-type: x mandatory; }
.nsh-snap-y { scroll-snap-type: y mandatory; }
.nsh-snap { position: absolute; left: 0; top: 0; width: 1px; height: 1px; pointer-events: none; scroll-snap-align: start; }
.nsh-snap-stop { scroll-snap-stop: always; }
.nsh-offscreen { position: fixed; left: -9999px; top: 0; opacity: 0; }
.nsh-probe { position: fixed; left: 0; top: 0; width: 0; height: 0; visibility: hidden; pointer-events: none;
  padding: env(safe-area-inset-top, 0px) env(safe-area-inset-right, 0px) env(safe-area-inset-bottom, 0px) env(safe-area-inset-left, 0px); }
.nsh-field.nsh-inset { inset: 0; }
.nsh-ph::placeholder { color: var(--ph); opacity: 1; }
.nsh-field { position: absolute; border: 0; outline: none; background: transparent; padding: 0; margin: 0;
  resize: none; font: inherit; color: inherit; -webkit-user-select: text; user-select: text; }
.nsh-selectable, .nsh-selectable * { -webkit-user-select: text; user-select: text; -webkit-touch-callout: default; }
.nsh-selectable ::selection { background: var(--nsh-selection, Highlight); }
.nsh-link { cursor: pointer; }
/* With the desktop idiom text is selectable as on a web page unless it is
   set off (selectable={false}) or inside something that takes presses
   or touches (nsh-press). */
.nsh-desktop .nsh-autoselect, .nsh-desktop .nsh-autoselect * { -webkit-user-select: text; user-select: text; }
.nsh-desktop .nsh-press .nsh-autoselect, .nsh-desktop .nsh-press .nsh-autoselect *,
.nsh-desktop .nsh-autoselect.nsh-press, .nsh-desktop .nsh-autoselect.nsh-press * { -webkit-user-select: none; user-select: none; }
.nsh-autoselect ::selection { background: var(--nsh-selection, Highlight); }
/* A selectable view (nsh-area) is selectable as a whole, with every idiom
   and inside views that take presses too: one browser selection spans its
   texts, and a drag may start between them. Texts set off (nsh-noselect),
   images and videos are not. Repeated classes outweigh the rules above. */
.nsh-root .nsh-area.nsh-area, .nsh-root .nsh-area.nsh-area * {
  -webkit-user-select: text; user-select: text; -webkit-touch-callout: default; }
.nsh-root .nsh-area .nsh-noselect.nsh-noselect, .nsh-root .nsh-area .nsh-noselect.nsh-noselect *,
.nsh-root .nsh-area.nsh-area img, .nsh-root .nsh-area.nsh-area video { -webkit-user-select: none; user-select: none; }
/* A page's header (the app's view): above the page's content. */
.nsh-page-header { z-index: 1; }
.nsh-screen { isolation: isolate; }
/* Modals: transparent layers over the root; what shows is the app's. */
.nsh-modal { transition: transform .35s cubic-bezier(.2,.8,.2,1), opacity .25s ease; z-index: 100; }
/* Dialogs and alerts over the window (dialogs: "viewport") are popovers in
   the top layer: above the page, wherever the container is, and as large as
   the window. The second rule undoes the popover's own box; an alert's
   backdrop below and the views' own classes override it. */
.nsh-root > .nsh-viewport { position: fixed; inset: 0; width: auto; height: auto; margin: 0; }
.nsh-viewport { touch-action: none; border: 0; padding: 0; overflow: visible; color: inherit; background-color: transparent; }
/* Anchored overlays over the window (overlays: "viewport", syncFloats) are popovers in the top layer too, at their
   frames in the root moved by where the root is in the window (--nsh-float-x / -y, placeFloats). The second rule
   undoes the popover's own box where the view's classes say nothing. */
.nsh-root > .nsh-float { position: fixed; inset: auto; margin: var(--nsh-float-y, 0px) 0 0 var(--nsh-float-x, 0px);
  touch-action: none; }
:where(.nsh-float) { border: 0; padding: 0; overflow: visible; color: inherit; background-color: transparent; }
.nsh-dialog-backdrop { position: absolute; inset: 0; background: rgba(0,0,0,.35); display: flex;
  align-items: center; justify-content: center; z-index: 1000; }
.nsh-dialog { width: 270px; border-radius: 14px; background: rgba(245,245,245,.97); color: #000; text-align: center;
  font: 13px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; overflow: clip; }
.nsh-dialog h3 { font-size: 17px; font-weight: 600; margin: 18px 16px 4px; }
.nsh-dialog p { margin: 0 16px 18px; }
.nsh-dialog button { display: block; width: 100%; border: 0; border-top: 0.5px solid rgba(0,0,0,.2); background: none;
  font: 17px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: #007aff; padding: 11px; cursor: default; }
/* Dialogs on desktop browsers: the in-surface cards of the Linux and macOS backends. */
.nsh-desktop .nsh-dialog-backdrop { background: rgba(0,0,0,.4); }
.nsh-desktop .nsh-dialog { width: min(340px, calc(100% - 64px)); border-radius: 12px; padding: 20px; text-align: left;
  background: #fff; color: #0a0a0a; border: 1px solid #e5e5e5; box-shadow: 0 10px 30px rgba(0,0,0,.25);
  font: 14px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
.nsh-desktop .nsh-dialog h3 { margin: 0 0 6px; font-size: 17px; }
.nsh-desktop .nsh-dialog p { margin: 0; font-size: 14px; color: #737373; overflow-wrap: anywhere; }
.nsh-desktop .nsh-dialog-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 14px; }
.nsh-desktop .nsh-dialog-actions.column { flex-direction: column; }
.nsh-desktop .nsh-dialog button { display: block; width: auto; padding: 7px 16px; border-radius: 8px; border: 1px solid #e5e5e5;
  background: #fff; color: #0a0a0a; font: 500 14px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
.nsh-desktop .nsh-dialog-actions.column button { width: 100%; }
.nsh-desktop .nsh-dialog button:hover { background: #f5f5f5; }
.nsh-desktop .nsh-dialog button:active { background: #e5e5e5; }
.nsh-desktop .nsh-dialog button.default { background: #171717; color: #fafafa; border-color: #171717; }
.nsh-desktop .nsh-dialog button.default:hover { background: #262626; }
.nsh-desktop .nsh-dialog button.destructive { background: #ef4444; color: #fff; border-color: #ef4444; }
.nsh-desktop .nsh-dialog button.destructive:hover { background: #dc2626; }
.nsh-desktop.nsh-dark .nsh-dialog { background: #171717; color: #fafafa; border-color: #262626; }
.nsh-desktop.nsh-dark .nsh-dialog p { color: #a3a3a3; }
.nsh-desktop.nsh-dark .nsh-dialog button { background: #171717; color: #fafafa; border-color: #262626; }
.nsh-desktop.nsh-dark .nsh-dialog button:hover { background: #262626; }
.nsh-desktop.nsh-dark .nsh-dialog button.default { background: #fafafa; color: #171717; border-color: #fafafa; }
.nsh-desktop.nsh-dark .nsh-dialog button.default:hover { background: #e5e5e5; }
.nsh-desktop.nsh-dark .nsh-dialog button.destructive { background: #f87171; color: #0a0a0a; border-color: #f87171; }
/* Phones: an iOS alert. */
.nsh-dialog-actions.row { display: flex; }
.nsh-dialog-actions.row button + button { border-left: 0.5px solid rgba(0,0,0,.2); }
.nsh-dialog button.cancel { font-weight: 600; }
.nsh-desktop .nsh-dialog button.cancel { font-weight: 500; }
.nsh-dialog button.destructive { color: #ff3b30; }
.nsh-dialog button:disabled { opacity: .4; }
.nsh-dialog-input { display: block; box-sizing: border-box; width: calc(100% - 32px); margin: 0 16px 16px; padding: 6px 8px;
  border: 0.5px solid rgba(0,0,0,.25); border-radius: 7px; background: #fff; color: inherit; outline: none;
  font: 13px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
.nsh-dialog h3 + .nsh-dialog-input { margin-top: 14px; }
.nsh-desktop .nsh-dialog-input { width: 100%; margin: 12px 0 0; padding: 7px 10px; border: 1px solid #e5e5e5;
  border-radius: 8px; font-size: 14px; }
.nsh-desktop .nsh-dialog-input:focus { border-color: #a3a3a3; }
.nsh-dark .nsh-dialog-input { background: rgba(28,28,30,.9); border-color: rgba(255,255,255,.2); }
.nsh-desktop.nsh-dark .nsh-dialog-input { background: #0a0a0a; border-color: #262626; }
.nsh-dark .nsh-dialog { background: rgba(44,44,46,.97); color: #fff; }
.nsh-dark .nsh-dialog button { border-top-color: rgba(255,255,255,.15); color: #0a84ff; }
.nsh-dark .nsh-dialog button.destructive { color: #ff453a; }
.nsh-dark .nsh-dialog-actions.row button + button { border-left-color: rgba(255,255,255,.15); }
/* Action sheets: cards at the bottom. */
.nsh-sheet-backdrop { align-items: flex-end; }
.nsh-sheet { width: min(420px, calc(100% - 16px)); margin-bottom: 8px; display: flex; flex-direction: column; gap: 8px;
  font: 13px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
.nsh-sheet > div { border-radius: 14px; background: rgba(245,245,245,.97); color: #000; overflow: hidden; text-align: center; }
.nsh-sheet .nsh-sheet-head { padding: 12px 16px; color: #8a8a8e; border-bottom: 0.5px solid rgba(0,0,0,.2); }
.nsh-sheet .nsh-sheet-head b { display: block; font-weight: 600; }
.nsh-sheet button { display: block; width: 100%; border: 0; background: none; padding: 16px; cursor: default;
  font: 19px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: #007aff; }
.nsh-sheet button + button { border-top: 0.5px solid rgba(0,0,0,.2); }
.nsh-sheet button.cancel { font-weight: 600; }
.nsh-sheet button.destructive { color: #ff3b30; }
.nsh-dark .nsh-sheet > div { background: rgba(44,44,46,.97); color: #fff; }
.nsh-dark .nsh-sheet button { color: #0a84ff; border-top-color: rgba(255,255,255,.15); }
.nsh-dark .nsh-sheet button.destructive { color: #ff453a; }
/* Alert and sheet buttons take focus when they open: no browser outline.
   Keyboard focus shows as a pressed tint on phones, a ring on desktop. */
.nsh-dialog button:focus, .nsh-sheet button:focus { outline: none; }
.nsh-dialog button:focus-visible, .nsh-sheet button:focus-visible { background: rgba(128,128,128,.12); }
.nsh-desktop .nsh-sheet > div { border-radius: 12px; padding: 6px; background: #fff; color: #0a0a0a; border: 1px solid #e5e5e5;
  box-shadow: 0 10px 30px rgba(0,0,0,.25); }
.nsh-desktop .nsh-sheet .nsh-sheet-head { color: #737373; border-bottom: 1px solid #e5e5e5; margin-bottom: 4px; padding: 8px 12px 12px; }
.nsh-desktop .nsh-sheet button { border: 0; border-radius: 8px; padding: 11px 16px; font-size: 16px; color: inherit; }
.nsh-desktop .nsh-sheet button:hover { background: rgba(128,128,128,.12); }
.nsh-desktop .nsh-sheet button.destructive { color: #ef4444; }
.nsh-desktop.nsh-dark .nsh-sheet > div { background: #171717; color: #fafafa; border-color: #262626; }
.nsh-desktop.nsh-dark .nsh-sheet .nsh-sheet-head { color: #a3a3a3; border-bottom-color: #262626; }
.nsh-desktop.nsh-dark .nsh-sheet button.destructive { color: #f87171; }
.nsh-desktop .nsh-dialog button:focus-visible { box-shadow: 0 0 0 3px rgba(163,163,163,.5); }
.nsh-desktop.nsh-dark .nsh-dialog button:focus-visible { box-shadow: 0 0 0 3px rgba(115,115,115,.5); }
.nsh-live { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
.nsh-layer { position: absolute; left: 0; top: 0; width: 0; height: 0; transform-origin: 0 0; }
.nsh-spinner { position: absolute; left: 50%; width: 20px; height: 20px; margin-left: -10px; pointer-events: none; z-index: 5; }
.nsh-spinner i { position: absolute; left: 8.75px; top: 0; width: 2.5px; height: 5.5px; border-radius: 1.25px;
  background: #404040; transform-origin: 1.25px 10px; opacity: .8; }
.nsh-spinner i:nth-child(2) { transform: rotate(45deg); }
.nsh-spinner i:nth-child(3) { transform: rotate(90deg); }
.nsh-spinner i:nth-child(4) { transform: rotate(135deg); }
.nsh-spinner i:nth-child(5) { transform: rotate(180deg); }
.nsh-spinner i:nth-child(6) { transform: rotate(225deg); }
.nsh-spinner i:nth-child(7) { transform: rotate(270deg); }
.nsh-spinner i:nth-child(8) { transform: rotate(315deg); }
.nsh-spinner.full i { opacity: 1; }
.nsh-spinner.full i:nth-child(2) { opacity: 0.25625; }
.nsh-spinner.full i:nth-child(3) { opacity: 0.3625; }
.nsh-spinner.full i:nth-child(4) { opacity: 0.46875; }
.nsh-spinner.full i:nth-child(5) { opacity: 0.575; }
.nsh-spinner.full i:nth-child(6) { opacity: 0.68125; }
.nsh-spinner.full i:nth-child(7) { opacity: 0.7875; }
.nsh-spinner.full i:nth-child(8) { opacity: 0.89375; }
.nsh-dark .nsh-spinner i { background: #fff; }
.nsh-spinner.spin { animation: nsh-spinner .8s steps(8) infinite; }
.nsh-error { position: absolute; left: 8px; right: 8px; bottom: 8px; max-height: 45%; overflow: auto; z-index: 2000;
  background: #1e1f22; color: #fff; font: 12px/1.4 ui-monospace, Menlo, monospace; padding: 10px 12px;
  border-left: 3px solid #ff6b6b; border-radius: 10px; white-space: pre-wrap; -webkit-user-select: text; user-select: text; }
.nsh-error-copy { float: right; position: sticky; top: 0; margin: 0 0 6px 10px; border: 0; border-radius: 6px;
  background: rgba(255,255,255,.12); color: #fff; font: 600 12px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  padding: 4px 12px; cursor: default; }
.nsh-error-copy:hover { background: rgba(255,255,255,.2); }
`;

/** An Apple keyboard: Command is the shortcut key, Option+Left moves by word. */
const APPLE = /mac|iphone|ipad/i.test(navigator.userAgentData?.platform ?? navigator.platform);

/**
 * Whether `nsh_key`'s answer consumes the key: a binding that fires (not one
 * passing the key through, `-3 - id`) or a held key's repeat.
 */
const consumedShortcut = (found) => found >= 0 || found === -2;

/** `nsh_key`'s codes of the keys that are not characters. */
const NAMED_KEYS = {
  Enter: 256, Escape: 257, Tab: 258, Backspace: 259, Delete: 260, Insert: 261, ArrowUp: 262, ArrowDown: 263,
  ArrowLeft: 264, ArrowRight: 265, Home: 266, End: 267, PageUp: 268, PageDown: 269,
};
/** The US layout's characters of the punctuation keys (`KeyboardEvent.code`). */
const CODE_CHARS = {
  Minus: "-", Equal: "=", BracketLeft: "[", BracketRight: "]", Backslash: "\\", IntlBackslash: "\\", Semicolon: ";",
  Quote: "'", Comma: ",", Period: ".", Slash: "/", Backquote: "`", Space: " ",
};

/** A name for the history entries of one load of the page. */
function newHistorySession() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
}

/** The current entry's place in the tab's history (the Navigation API's
 * `navigation.currentEntry.index`), `null` where the browser has no
 * Navigation API. */
function navigationIndex() {
  const index = globalThis.navigation?.currentEntry?.index;
  return Number.isInteger(index) && index >= 0 ? index : null;
}

/** The offset of local time at `ms` (since the epoch) in seconds east of UTC. */
function localOffset(ms) {
  return 0 - new Date(ms).getTimezoneOffset() * 60;
}

/**
 * Whether the page can show the browser's share sheet: it has
 * `navigator.share` and the page's permissions policy allows `web-share`
 * (a frame of another origin needs `allow="web-share"`).
 */
function webShareAllowed() {
  if (typeof navigator === "undefined" || typeof navigator.share !== "function") return false;
  const doc = typeof document === "undefined" ? undefined : document;
  const policy = doc?.permissionsPolicy ?? doc?.featurePolicy;
  return typeof policy?.allowsFeature === "function" ? policy.allowsFeature("web-share") : true;
}

/** The kinds `network()` names for `navigator.connection.type`'s. */
const CONNECTION_KINDS = {
  wifi: "wifi", cellular: "cellular", ethernet: "wired", none: "none",
  bluetooth: "other", wimax: "other", mixed: "other", other: "other",
};

/**
 * How the page reaches the network (`network()`): `none` while the
 * browser says it is offline (`navigator.onLine`, which is true whenever
 * the browser has a link, even one without the internet), else the link
 * `navigator.connection` names (Chromium on Android; desktop browsers name
 * none: `unknown`). The link is expensive when it is cellular, constrained
 * when the user asked to save data (`saveData`).
 */
function webNetwork(nav = typeof navigator === "undefined" ? undefined : navigator) {
  const connection = nav?.connection;
  const kind = nav?.onLine === false ? "none" : CONNECTION_KINDS[connection?.type] ?? "unknown";
  return { kind, expensive: kind === "cellular", constrained: connection?.saveData === true };
}

/** The browser's time zone (`Asia/Shanghai`), Intl's default; "" when unknown. */
function timeZoneName() {
  return new Intl.DateTimeFormat().resolvedOptions().timeZone ?? "";
}

/**
 * What the browser knows of the regional preferences of `locale`
 * (`localeSettings()`'s `hourCycle` and the like): its hour cycle and first day of the week,
 * and the locale with its likely region (`de` is `de-Latn-DE`), which has
 * the others. Browsers tell no user settings of them.
 */
function regional(locale) {
  const known = { locale };
  try {
    const l = new Intl.Locale(locale);
    known.locale = l.maximize().toString();
    // `weekInfo` before browsers made it `getWeekInfo()`.
    known.firstDay = (l.getWeekInfo?.() ?? l.weekInfo)?.firstDay;
    known.hourCycle = new Intl.DateTimeFormat(locale, { hour: "numeric" }).resolvedOptions().hourCycle;
  } catch {
    // A tag the browser does not take: the region's.
  }
  return known;
}

/** The characters of `text` as `maxLength` counts them: Unicode code
 * points (an emoji is one, though a JS string holds two units for it). */
function charLength(text) {
  let n = 0;
  for (const _ of text) n++;
  return n;
}

let graphemes;

/** The longest prefix of `text` of at most `max` characters
 * ({@link charLength}) that ends between user-perceived characters, as the
 * core's `clip_chars` cuts: a letter with its accent or an emoji with its
 * skin tone goes in whole or not at all. */
function clipChars(text, max) {
  if (max <= 0) return "";
  if (text.length <= max || charLength(text) <= max) return text;
  graphemes ??= typeof Intl !== "undefined" && typeof Intl.Segmenter === "function"
    ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
    : null;
  // Without `Intl.Segmenter`, between code points.
  const parts = graphemes ? graphemes.segment(text) : text;
  let used = 0;
  let end = 0;
  for (const part of parts) {
    const segment = typeof part === "string" ? part : part.segment;
    used += charLength(segment);
    if (used > max) break;
    end += segment.length;
  }
  return text.slice(0, end);
}

/**
 * The key of a key event as `nsh_key` takes it (-1: none): the character
 * it types without modifiers, or, when Shift or Option change it or the
 * layout types no ASCII there, the US layout's character of the same key
 * (shortcuts work on any layout, as menus' do).
 */
function keyCode(e) {
  // Some IME and webview key events carry no `key`; fall back to `code`.
  const k = typeof e.key === "string" ? e.key : "";
  const named = NAMED_KEYS[k];
  if (named) return named;
  const f = /^F([0-9]{1,2})$/.exec(k);
  if (f) return Number(f[1]) >= 1 && Number(f[1]) <= 24 ? 512 + Number(f[1]) : -1;
  if (k.length === 1 && !e.shiftKey && !e.altKey && k >= " " && k <= "~") return k.toLowerCase().charCodeAt(0);
  const c = e.code ?? "";
  if (/^Key[A-Z]$/.test(c)) return c.charCodeAt(3) + 32;
  if (/^(Digit|Numpad)[0-9]$/.test(c)) return c.charCodeAt(c.length - 1);
  return CODE_CHARS[c]?.charCodeAt(0) ?? -1;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * The style classes of the document, shared by its players: no element
 * carries an inline style but its geometry and animated values. A class
 * named after its CSS (`nsh-` and 8 hex digits of its FNV-1a hash, made by
 * the engine, `op_css`, or here, `cssClass`) is one rule whatever defines
 * it; a view's own rule (`i<id>…` from the engine, `nsh-p<player>-` in
 * front) is replaced as the view's style changes. Name -> its CSS text.
 */
const CLASSES = { sheets: {}, rules: new Map(), texts: new Map() };

/** A style sheet of the runtime's own, after the page's and the earlier
 * ones, holding `text`: a constructed sheet the document adopts, which a
 * strict `style-src` allows (it refuses `<style>` elements), or in a
 * browser without them a `<style>` element (`id`). */
function runtimeSheet(id, text = "") {
  if (typeof CSSStyleSheet === "function" && "replaceSync" in CSSStyleSheet.prototype && "adoptedStyleSheets" in document) {
    const sheet = new CSSStyleSheet();
    if (text) sheet.replaceSync(text);
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
    return sheet;
  }
  const style = document.createElement("style");
  style.id = id;
  style.textContent = text;
  document.head.append(style);
  return style.sheet;
}

/** The sheet of the generated classes (`nsh-classes`), after the runtime's
 * own rules, or of the views' own rules (`nsh-own`): changing a rule makes
 * the browser go over its whole sheet again, so those that change are
 * apart. */
function classSheet(id) {
  if (!CLASSES.sheets[id]) CLASSES.sheets[id] = runtimeSheet(id);
  return CLASSES.sheets[id];
}

/** The document's sheet of the runtime's own rules ([`KEYFRAMES`]), made
 * by the first player of any copy of the runtime on the page. */
const RUNTIME_SHEET = Symbol.for("nsh.runtimeSheet");


/** Adds (or, for a view's own rule, replaces) class `name` with `text`.
 * The class is doubled: it wins over the runtime's rules of a class and a
 * pseudo-class (`.nsh-v:focus`), as inline styles did. */
function defineClass(name, text, replace, weight = 2) {
  const rule = CLASSES.rules.get(name);
  if (rule) {
    if (replace) rule.style.cssText = text;
    else if (CLASSES.texts.get(name) !== text) console.warn(`[nsh] two styles named ${name}:`, CLASSES.texts.get(name), text);
    return;
  }
  const sheet = classSheet(replace ? "nsh-own" : "nsh-classes");
  try {
    const i = sheet.insertRule(`${`.${name}`.repeat(weight)}{${text}}`, sheet.cssRules.length);
    CLASSES.rules.set(name, sheet.cssRules[i]);
    CLASSES.texts.set(name, text);
  } catch (err) {
    console.warn("[nsh] style rule not accepted:", text, err);
  }
}

/** Whether the browser draws `corner-shape` (Chromium; not Safari or Firefox so far). */
const CORNER_SHAPE = typeof CSS !== "undefined" && CSS.supports?.("corner-shape", "squircle");
/** How far along each edge a continuous corner of radius 1 reaches, as Core Animation's. */
const CONTINUOUS_REACH = 1.528;
/** The `superellipse()` that at that reach passes where a circle of radius 1 does on the diagonal. */
const CONTINUOUS_SUPERELLIPSE = 1.7;

/** The class of CSS text `text` (as the engine names them), defined when
 * new; `weight` repeats it in the selector, over the views' style classes. */
function cssClass(text, weight = 2) {
  let h = 0x811c9dc5;
  for (const b of encoder.encode(text)) h = Math.imul(h ^ b, 0x01000193);
  const name = `nsh-${(h >>> 0).toString(16).padStart(8, "0")}`;
  defineClass(name, text, false, weight);
  return name;
}

/** Puts `el` in class `name` in place of its previous one of `slot`. */
function swapClass(el, slot, name) {
  const old = el[slot];
  if (old === name) return;
  if (old) el.classList.remove(old);
  if (name) el.classList.add(name);
  el[slot] = name;
}

/** Fills a run with `text`, the characters of links (`parts`: `[from, to,
 * link]`, UTF-16) in spans inside it that name their link (`links`):
 * inline, they keep the run's shaping and bidi order. */
/**
 * The one color text view `el` is drawn in (null: several, which its runs
 * carry): on the element, which the runs inherit it from, so a change of it
 * transitions as CSS's `color` does (`transition-colors`, from the color on
 * screen, whatever runs are made meanwhile). A text that was several colors
 * takes its one color at once, as on the native backends.
 */
function setTextColor(el, color) {
  const shown = el._textColor;
  if (color === shown) return;
  el._textColor = color;
  if (color == null) {
    el.style.color = "";
  } else if (shown === null) {
    // From several colors: no transition from the element's stale color.
    const transition = el.style.transition;
    el.style.transition = "none";
    el.style.color = color;
    void getComputedStyle(el).color;
    el.style.transition = transition;
  } else {
    el.style.color = color;
  }
}

function fillRun(run, text, parts, links) {
  if (!parts) {
    run.textContent = text;
    return;
  }
  let at = 0;
  for (const [from, to, link] of parts) {
    if (from > at) run.append(text.slice(at, from));
    const span = document.createElement("span");
    span.textContent = text.slice(from, to);
    span._link = links[link];
    // A link's pointer over the I-beam of selectable text, as a browser's
    // `<a>` and the other desktops' link spans.
    if (PRESS_EVENTS.some((e) => span._link.events.has(e))) span.classList.add("nsh-link");
    run.append(span);
    at = to;
  }
  if (at < text.length) run.append(text.slice(at));
}

/** The text node and offset of character `offset` of a run. */
function runPoint(run, offset) {
  const walker = document.createTreeWalker(run, NodeFilter.SHOW_TEXT);
  let node = null;
  for (let next = walker.nextNode(); next; next = walker.nextNode()) {
    node = next;
    if (offset <= node.length) return [node, offset];
    offset -= node.length;
  }
  return node ? [node, node.length] : [run, 0];
}

/** The character standing for an attachment in a text's content. */
const ATTACHMENT = String.fromCharCode(0xfffc);

/**
 * The copy texts (`copyText`) of a text's attachments that a copy puts
 * `before` run `run`'s characters (else after them, before the line's
 * break), of those in the selected UTF-16 range `start..end`. `copies` are
 * `[offset, text, run, before]`, as the text's mount item sends them: the
 * runs hold no attachments.
 */
function copiesAround(copies, run, before, start, end) {
  let out = "";
  for (const [at, text, r, b] of copies ?? []) {
    if (r === run && !!b === before && at >= start && at < end) out += text;
  }
  return out;
}

/** The offset in a run of a boundary (`container`, `offset`) inside it. */
function runOffset(run, container, offset) {
  const range = document.createRange();
  range.setStart(run, 0);
  range.setEnd(container, offset);
  return range.toString().length;
}

let players = 0;

/** How many players imported each wasm-bindgen glue, by URL. */
const glueImports = new Map();

/**
 * Imports the wasm-bindgen glue at `url` for one player. The glue keeps its
 * module's state (memory views, wasm-bindgen's heap) at its top level, so
 * every player after the first imports it under a URL of its own: another
 * instance of the module. The first keeps the URL the page preloads.
 */
function importGlue(url, base) {
  const href = new URL(String(url), base);
  const imported = glueImports.get(href.href) ?? 0;
  glueImports.set(href.href, imported + 1);
  if (imported > 0) href.searchParams.set("player", String(imported));
  return import(href.href);
}

/**
 * The script a web view's HTML starts with: the first message from the
 * player carrying `token` hands it the port `window.nsh.postMessage`
 * writes to, and which runs `injectJavaScript` and history steps. The
 * page's own `message` listeners never see that message.
 */
function webBridge(token) {
  return `(() => {
  let port = null;
  const queue = [];
  window.nsh = { postMessage(data) { data = String(data); port ? port.postMessage(data) : queue.push(data); } };
  addEventListener("message", (e) => {
    if (port || e.source !== parent || e.data !== ${JSON.stringify(token)} || !e.ports[0]) return;
    e.stopImmediatePropagation();
    port = e.ports[0];
    port.onmessage = (m) => {
      const d = m.data;
      if (d && d.eval != null) { try { (0, eval)(String(d.eval)); } catch (err) { console.error(err); } }
      else if (d && d.go) history.go(d.go);
    };
    for (const data of queue.splice(0)) port.postMessage(data);
  });
})();`;
}

/// Measurements between dropping the measuring context (see `measure_text`):
/// 5000 ≈ 4 seconds for a table that measures on every frame, which holds
/// Blink's shape cache around 5 MB.
const MEASURE_ROUNDS = 5000;

function measureContext() {
  const canvas = typeof OffscreenCanvas !== "undefined"
    ? new OffscreenCanvas(1, 1)
    : document.createElement("canvas");
  return canvas.getContext("2d");
}

/** The span `measureNumericText` measures in (one for the page's players). */
let numericSpan = null;

/**
 * The width of `text` in CSS `font` with `font-variant-numeric: numeric`
 * (`tabular-nums`, ...). Canvas text cannot have numeric variants: its
 * `font` takes only `small-caps`, and the context has `fontVariantCaps`
 * but no `fontVariantNumeric`, so `measureText` measures proportional
 * digits, narrower than the tabular ones the run is drawn with. A hidden
 * span with the run's CSS measures what the DOM draws (font-variant-numeric:
 * Chrome 52, Firefox 34, Safari 9.1). Its layout is forced, so the engine
 * asks only for text with a numeric variant, and caches the answers.
 */
function measureNumericText(font, numeric, text) {
  if (typeof document === "undefined" || !document.body) return null;
  if (!numericSpan?.isConnected) {
    const box = document.createElement("div");
    box.setAttribute("aria-hidden", "true");
    box.style.cssText = "position:fixed;left:0;top:0;width:0;height:0;overflow:hidden;"
      + "visibility:hidden;pointer-events:none;contain:strict";
    numericSpan = document.createElement("span");
    numericSpan.style.cssText = "position:absolute;left:0;top:0;white-space:pre;"
      + "letter-spacing:normal;word-spacing:normal;text-transform:none;font-kerning:auto;"
      + "font-feature-settings:normal";
    box.append(numericSpan);
    document.body.append(box);
  }
  // `font` resets the variant: set it first, as the run's CSS does.
  numericSpan.style.letterSpacing = "normal";
  numericSpan.style.font = font;
  numericSpan.style.fontVariantNumeric = numeric;
  numericSpan.textContent = text;
  return numericSpan.getBoundingClientRect().width;
}

/** Cluster rectangles in a complete drawn run. Reuse the measuring span;
 * range queries keep shaping and bidi ordering exactly as the DOM draws them.
 * Only the first hit test of a layout pays for these measurements. */
function textClusterBoxes(font, numeric, spacing, text, ranges) {
  measureNumericText(font, numeric || "normal", text);
  numericSpan.style.direction = "ltr";
  numericSpan.style.letterSpacing = `${spacing}px`;
  const origin = numericSpan.getBoundingClientRect().left;
  const node = numericSpan.firstChild;
  const range = document.createRange();
  return ranges.map(([start, end]) => {
    range.setStart(node, start);
    range.setEnd(node, end);
    const box = range.getBoundingClientRect();
    return [box.left - origin, box.right - origin];
  });
}

/** Whether `locale`'s script is written right to left. */
function rightToLeft(locale) {
  try {
    const l = new Intl.Locale(locale);
    const info = l.getTextInfo?.() ?? l.textInfo;
    if (info?.direction) return info.direction === "rtl";
    const script = l.maximize().script;
    if (script) return ["Arab", "Hebr", "Thaa", "Syrc", "Nkoo", "Adlm", "Rohg"].includes(script);
  } catch {
    // Not a valid tag.
  }
  return /^(ar|he|iw|fa|ur|ps|sd|ug|yi|dv|ckb|syr)(-|$)/i.test(locale);
}

/** Hosts viewport dialogs from a cross-origin player iframe. Call once on
 * the embedding page; the returned function disconnects the host. Same-origin
 * players arrange this directly. Only this iframe's window may request it. */
export function hostPlayerFrame(frame) {
  const win = frame.ownerDocument.defaultView, leases = new Set();
  const closeAll = () => { for (const close of [...leases]) close(); };
  const message = (event) => {
    if (event.source !== frame.contentWindow || event.data?.type !== "nsh:viewport" || !event.ports[0]) return;
    const port = event.ports[0];
    let release;
    const close = () => { release?.(); release = null; port.close(); leases.delete(close); };
    try {
      const lease = frameViewport(frame, event.data.colorScheme === "dark" ? "dark" : "light");
      release = lease.release;
      leases.add(close);
      port.onmessage = (e) => { if (e.data === "release") close(); };
      port.postMessage(lease.rect);
    } catch (error) {
      port.postMessage({ error: String(error) });
      close();
    }
  };
  win.addEventListener("message", message);
  frame.addEventListener("load", closeAll);
  const observer = new win.MutationObserver(() => { if (!frame.isConnected) closeAll(); });
  observer.observe(frame.ownerDocument, { childList: true, subtree: true });
  return () => {
    closeAll(); observer.disconnect();
    win.removeEventListener("message", message);
    frame.removeEventListener("load", closeAll);
  };
}

/** The color scheme `doc` is drawn with: `"dark"` or `"light"`. An iframe
 * whose scheme differs from its document's is painted opaque, so a frame
 * lifted over its page takes its document's. */
function usedColorScheme(doc) {
  const win = doc.defaultView;
  let value = win.getComputedStyle(doc.documentElement).colorScheme;
  if (!value || value === "normal") value = doc.querySelector('meta[name="color-scheme"]')?.content ?? "";
  const words = value.split(/\s+/);
  if (words.includes("dark") && words.includes("light")) return win.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  return words.includes("dark") ? "dark" : "light";
}

/** A modal owns the page around its branch until the last lease ends. */
function lockViewportPage(branch) {
  const doc = branch.ownerDocument, html = doc.documentElement;
  const state = doc._nshViewportPage ??= {
    leases: [], inert: new Map(), overflow: html.style.getPropertyValue("overflow"),
    priority: html.style.getPropertyPriority("overflow"),
  };
  const lease = { branch };
  const sync = () => {
    for (const [node, inert] of state.inert) node.inert = inert;
    state.inert.clear();
    const top = state.leases.at(-1)?.branch;
    if (!top) {
      html.style.setProperty("overflow", state.overflow, state.priority);
      delete doc._nshViewportPage;
      return;
    }
    html.style.setProperty("overflow", "hidden", "important");
    for (let node = top; node?.parentElement; node = node.parentElement) {
      for (const sibling of node.parentElement.children) {
        if (sibling === node || ["HEAD", "SCRIPT", "STYLE"].includes(sibling.tagName)) continue;
        state.inert.set(sibling, sibling.inert); sibling.inert = true;
      }
    }
  };
  state.leases.push(lease); sync();
  return () => { state.leases = state.leases.filter(l => l !== lease); sync(); };
}

/** Elevate the iframe itself without moving/reloading its document. Its
 * popovers can then cover the host viewport while the app keeps its size. */
function frameViewport(frame, colorScheme) {
  if (frame._nshViewport) {
    const state = frame._nshViewport;
    state.users++;
    return { rect: state.rect, release: () => state.release() };
  }
  const doc = frame.ownerDocument, win = doc.defaultView;
  const bounds = frame.getBoundingClientRect();
  const sx = bounds.width / (frame.offsetWidth || bounds.width);
  const sy = bounds.height / (frame.offsetHeight || bounds.height);
  let rect = { left: bounds.left + frame.clientLeft * sx, top: bounds.top + frame.clientTop * sy, sx, sy };
  let outer;
  if (win.parent !== win) {
    // A same-origin ancestor chain is lifted all the way to its outer page.
    const parentFrame = win.frameElement;
    if (!parentFrame) throw new Error("install hostPlayerFrame in the outer embedding page");
    outer = frameViewport(parentFrame, usedColorScheme(doc));
    rect = { left: outer.rect.left + rect.left * outer.rect.sx, top: outer.rect.top + rect.top * outer.rect.sy,
      sx: sx * outer.rect.sx, sy: sy * outer.rect.sy };
  }
  const saved = frame.getAttribute("style"), popover = frame.getAttribute("popover");
  const focused = doc.activeElement;
  const css = win.getComputedStyle(frame);
  let placeholder;
  if (css.position !== "absolute" && css.position !== "fixed") {
    placeholder = doc.createElement("span");
    placeholder.style.cssText = `display:inline-block;width:${frame.offsetWidth}px;height:${frame.offsetHeight}px;vertical-align:${css.verticalAlign};margin:${css.margin}`;
    frame.before(placeholder);
  }
  frame.setAttribute("popover", "manual");
  for (const [name, value] of Object.entries({ position: "fixed", inset: "0", width: "100%", height: "100%",
    "min-width": "0", "min-height": "0", "max-width": "none", "max-height": "none",
    "border-radius": "0", "clip-path": "none", background: "transparent", margin: "0", border: "0", padding: "0", transform: "none", "box-sizing": "border-box",
    "color-scheme": colorScheme })) {
    frame.style.setProperty(name, value, "important");
  }
  try { frame.showPopover(); } catch (error) {
    if (saved === null) frame.removeAttribute("style"); else frame.style.cssText = saved;
    if (popover === null) frame.removeAttribute("popover"); else frame.setAttribute("popover", popover);
    placeholder?.remove(); outer?.release(); throw error;
  }
  const unlock = lockViewportPage(frame);
  frame.focus({ preventScroll: true });
  const state = frame._nshViewport = { users: 1, rect, release() {
    if (frame._nshViewport !== state || --state.users) return;
    observer.disconnect();
    frame.hidePopover();
    if (saved === null) frame.removeAttribute("style"); else frame.style.cssText = saved;
    if (popover === null) frame.removeAttribute("popover"); else frame.setAttribute("popover", popover);
    unlock();
    placeholder?.remove(); outer?.release(); delete frame._nshViewport;
    if (focused?.isConnected) focused.focus({ preventScroll: true });
  } };
  const observer = new win.MutationObserver(() => {
    if (!frame.isConnected) { state.users = 1; state.release(); }
  });
  observer.observe(doc, { childList: true, subtree: true });
  return { rect, release: () => state.release() };
}

/** Loads the runtime and makes a player in `container`. */
export async function createPlayer(container, options = {}) {
  const player = new Player(container, options);
  await player.load(options.wasm ?? new URL("nsh.wasm", import.meta.url));
  return player;
}

/** A CSS color as `#rrggbb`, `#rrggbbaa` or `rgba(r,g,b,a)` (what the
 * animator writes) in 0..1 components. */
function parseCssColor(value) {
  const v = String(value).trim();
  if (v.startsWith("#")) {
    const n = (i) => parseInt(v.slice(i, i + 2), 16) / 255;
    return [n(1), n(3), n(5), v.length >= 9 ? n(7) : 1];
  }
  const m = v.match(/\(([^)]*)\)/);
  if (!m) return [0, 0, 0, 0];
  const p = m[1].split(",").map(Number);
  return [p[0] / 255, p[1] / 255, p[2] / 255, p.length > 3 ? p[3] : 1];
}

class Player {
  /** The player that last took input (keys go to it while nothing has the focus). */
  static active = null;

  constructor(container, options) {
    this.options = options;
    // The page's URL as the player starts: the runtime's files and the
    // app's relative URLs resolve against it once, so they still load
    // after the address moves to another directory (`history.pushState`
    // to `/sports/football`).
    // The site's base when the page names it (`baseURL`): the page's
    // address is one of the app's routes, below it.
    this.siteBase = options.baseURL == null ? null : new URL(String(options.baseURL), document.baseURI).href;
    this.baseURL = this.siteBase ?? document.baseURI;
    this.assetBase = new URL(options.assetBase || "./", this.baseURL).href;
    const resolve = (urls) => urls && Object.fromEntries(Object.entries(urls).map(([key, url]) => [key, new URL(url, this.baseURL).href]));
    this.assets = resolve(options.assets);
    this.data = resolve(options.data);
    this.container = container;
    if (!document[RUNTIME_SHEET]) {
      Object.defineProperty(document, RUNTIME_SHEET, { value: runtimeSheet("nsh-style", KEYFRAMES) });
    }
    this.root = document.createElement("div");
    this.root.className = window.top === window ? "nsh-root" : "nsh-root nsh-embedded";
    // Its size is in the class: the core styles the root too (a
    // right-to-left layout), which replaces its inline style.
    container.append(this.root);
    this.views = new Map();
    this.mouseTracked = new Set();
    /** Views listening to `onWheel`; wheels look for none without. */
    this.wheelTracked = new Set();
    // Shader views (`op_sh`), drawn on one WebGL 2 context (`shaderGl`).
    this.shaderViews = new Set();
    // Of the views' own style rules (`op_css`).
    this.classPrefix = `nsh-p${++players}-`;
    this.timer = 0;
    // The engine trapped: it takes no more calls (`call`).
    this.trapped = false;
    // An `nsh_pump` is queued (`requestPump`).
    this.pumpRequested = false;
    this.frame = 0;
    this.measure = measureContext();
    this.measureUses = 0;
    this.metricsCache = new Map();
    this.layoutAnimation = null;
    // Views created and removed while a layout animation is configured.
    this.appearing = [];
    this.disappearing = [];
    this.changedStacks = new Set();
    // Scroll views (or their content layers) whose content the batch
    // placed or added to (`orderReading`).
    this.readingHosts = new Set();
    // Views removed by the batch being applied (`finishRemovals`).
    this.removals = [];
    this.images = new Map();
    // Browser blob URLs of the in-memory images (`data:` URIs, blobs) the
    // views show, by the source's URI (`image_bytes`).
    this.inlineImages = new Map();
    // `svg()`s drawn in their text color: the SVG's text by its address
    // (a promise while it loads), and its blob URL by address and color
    // (`svgInColor`).
    this.svgTexts = new Map();
    this.coloredSvgs = new Map();
    this.pointers = new Map();
    this.requests = new Map();
    this.websockets = new Map();
    this.fileOperations = new Map();
    this.dark = options.dark ?? matchMedia("(prefers-color-scheme: dark)").matches;
    // The navigation stacks and modals are the browser's history: by
    // default only when the app is the page (in an iframe each push would
    // be an entry of the embedding page's history too).
    this.history = options.history ?? window.top === window;
    // `Dialog` and `AlertDialog` over the whole window rather than over the
    // container: popovers in the top layer, which every browser engine has
    // had since 2024 (Firefox 125).
    this.viewportDialogs = options.dialogs === "viewport" && typeof HTMLElement.prototype.showPopover === "function";
    if (options.dialogs === "viewport" && !this.viewportDialogs) {
      console.warn("[nsh] this browser has no popovers: dialogs cover the player, not the window");
    }
    // Anchored overlays (popovers, menus, tooltips, a select's list) over
    // the whole window rather than inside the container (`syncFloats`).
    this.viewportOverlays = options.overlays === "viewport" && typeof HTMLElement.prototype.showPopover === "function";
    if (options.overlays === "viewport" && !this.viewportOverlays) {
      console.warn("[nsh] this browser has no popovers: overlays stay inside the player, not over the window");
    }
    // Host events sent before the app runs (`begin`).
    this.hostEvents = [];
    if (window.top === window) document.documentElement.classList.add("nsh-page");
  }

  async load(url) {
    // An app's crates that call JS through wasm-bindgen (web-sys, js-sys):
    // the CLI ran `wasm-bindgen --target web` on the runtime, and its glue
    // provides the module's other imports. It loads while the module
    // compiles; a failed compile does not leave its rejection unhandled.
    const glueLoad = this.options.glue ? importGlue(this.options.glue, this.baseURL) : null;
    glueLoad?.catch(() => {});
    const imports = {
      env: {
        __nsh_random_fill: (ptr, len) => {
          try {
            const bytes = this.bytes(ptr, len);
            for (let offset = 0; offset < len; offset += 65536) {
              globalThis.crypto.getRandomValues(bytes.subarray(offset, Math.min(offset + 65536, len)));
            }
            return 0;
          } catch { return -1; }
        },
      },
      nsh: {
        now_ms: () => performance.now(),
        date_now_ms: () => Date.now(),
        // Today where the app runs (`nsh-base`'s calendars).
        local_offset: (ms) => localOffset(ms),
        // Intl's default zone.
        time_zone: (p, cap) => {
          const zone = encoder.encode(timeZoneName());
          if (zone.length <= cap) this.bytes(p, cap).set(zone);
          return zone.length;
        },
        measure_text: (fp, fl, tp, tl) => {
          // Blink keeps every shaped string in the measuring context's
          // PlainTextPainter (a FrameShapeCache keyed by font), and drops it
          // only under critical memory pressure: an app that measures strings
          // it has not measured before — a price table measuring the numbers
          // that changed, every frame — piles up `blink::PlainTextNode`s
          // without bound (25 MB in 20s, 52 MB in 6 minutes for a 40-row
          // table). A context is cheap, and a fresh one starts empty; the old
          // one, its painter and its cache become unreachable and go.
          if (++this.measureUses >= MEASURE_ROUNDS) {
            this.measureUses = 0;
            this.measure = measureContext();
          }
          this.measure.font = this.str(fp, fl);
          return this.measure.measureText(this.str(tp, tl)).width;
        },
        measure_numeric_text: (fp, fl, np, nl, tp, tl) => {
          const font = this.str(fp, fl), text = this.str(tp, tl);
          const width = measureNumericText(font, this.str(np, nl), text);
          if (width != null) return width;
          this.measure.font = font;
          return this.measure.measureText(text).width;
        },
        text_cluster_boxes: (fp, fl, np, nl, spacing, tp, tl, rp, op, count) => {
          const input = new Uint32Array(this.wasm.memory.buffer, rp, count * 2);
          const ranges = Array.from({ length: count }, (_, i) => [input[2*i], input[2*i+1]]);
          const boxes = textClusterBoxes(this.str(fp, fl), this.str(np, nl), spacing, this.str(tp, tl), ranges);
          // DOM layout cannot grow wasm memory, so this view stays valid.
          const output = new Float32Array(this.wasm.memory.buffer, op, count * 2);
          boxes.forEach(([left, right], i) => { output[2*i] = left; output[2*i+1] = right; });
        },
        font_ascent: (fp, fl) => this.metrics(this.str(fp, fl))[0],
        font_descent: (fp, fl) => this.metrics(this.str(fp, fl))[1],
        font_x_height: (fp, fl) => this.metrics(this.str(fp, fl))[2],
        register_font: (fp, fl, dp, dl, weight, maxWeight, italic) => {
          const family = this.str(fp, fl);
          const data = this.bytes(dp, dl).slice();
          // A variable font gets its `wght` range: one value would pin the axis.
          const range = maxWeight > weight ? `${weight} ${maxWeight}` : String(weight);
          const face = new FontFace(family, data, { weight: range, style: italic ? "italic" : "normal" });
          document.fonts.add(face);
          this.fontLoading(face.load());
        },
        image_bytes: (up, ul, dp, dl) => {
          const uri = this.str(up, ul);
          const old = this.inlineImages.get(uri);
          if (old) URL.revokeObjectURL(old);
          // The key names the media type (`data:<type>;nsh-key=…`): browsers
          // draw an SVG blob only with its type.
          const type = uri.startsWith("data:") ? uri.slice(5, uri.indexOf(";")) : "";
          const blob = URL.createObjectURL(new Blob([this.bytes(dp, dl).slice()], { type }));
          if (old) this.forgetColoredSvgs(old);
          this.inlineImages.set(uri, blob);
          if (type === "image/svg+xml") this.svgTexts.set(blob, new TextDecoder().decode(this.bytes(dp, dl)));
        },
        release_image: (p, l) => {
          const uri = this.str(p, l);
          const url = this.inlineImages.get(uri);
          if (url) {
            URL.revokeObjectURL(url);
            this.forgetColoredSvgs(url);
          }
          this.inlineImages.delete(uri);
        },
        submit: (p, l) => {
          const batch = JSON.parse(this.str(p, l));
          this.apply(batch);
        },
        request_frame: () => this.requestFrame(),
        request_pump: () => this.requestPump(),
        report_error: (p, l) => this.showError(this.str(p, l)),
        report_panic: (p, l) => this.reportPanic(this.str(p, l)),
        test_send: (p, l) => this.onTestSend?.(JSON.parse(this.str(p, l))),
        log: (level, p, l) => {
          const message = this.str(p, l);
          (level <= 1 ? console.error : level === 2 ? console.warn : console.log)("[nsh]", message);
          this.options.onLog?.(level <= 1 ? "error" : level === 2 ? "warn" : "log", message);
        },
        read_asset: (p, l) => {
          const data = this.options.readAsset?.(this.str(p, l));
          if (!data) return 0;
          this.withStrings([data], (dp, dl) => this.wasm.nsh_asset_bytes(dp, dl));
          return 1;
        },
        // Where `asset:/…` is served, for the engine to download a file the
        // page did not preload (Rust's `read_asset`).
        asset_url: (up, ul, p, cap) => {
          const url = encoder.encode(this.asset(this.str(up, ul)));
          if (url.length <= cap) this.bytes(p, cap).set(url);
          return url.length;
        },
        fetch_start: (id, mp, ml, up, ul, hp, hl, bp, bl, kind, follow, cp, cl) =>
          this.fetchStart(id, this.str(mp, ml), this.str(up, ul), JSON.parse(this.str(hp, hl)),
            kind === 1 ? this.bytes(bp, bl).slice() : null, kind === 2, follow !== 0, this.str(cp, cl)),
        fetch_send: (id, p, l) => this.fetchSend(id, this.bytes(p, l).slice()),
        fetch_finish: (id) => this.requests.get(id)?.finish?.(),
        fetch_pause: (id, paused) => this.fetchPause(id, paused !== 0),
        fetch_cancel: (id) => this.fetchCancel(id),
        filesystem_start: (id, p, l, bp, bl) => this.filesystemStart(id, JSON.parse(this.str(p, l)), this.bytes(bp, bl).slice()),
        filesystem_cancel: (id) => this.fileOperations.delete(id),
        websocket_start: (id, p, l) => this.websocketOperation(() => this.websocketStart(id, JSON.parse(this.str(p, l)))),
        websocket_send: (id, p, l, binary) => this.websocketOperation(() => {
          const socket = this.websockets.get(id);
          if (!socket) throw new Error("WebSocket is closed");
          socket.send(binary ? this.bytes(p, l).slice() : this.str(p, l));
        }),
        websocket_close: (id, code, p, l) => this.websocketOperation(() => {
          const socket = this.websockets.get(id);
          if (socket) socket.close(code, this.str(p, l));
        }),
        websocket_buffered: (id) => this.websockets.get(id)?.bufferedAmount ?? 0,
        websocket_pause: (id, paused) => this.websocketPause(id, paused !== 0),
        websocket_cancel: (id) => this.websocketCancel(id),
        load_data: (p, l) => this.loadData(this.str(p, l)),
        // The app's storage (`nsh/storage`): the entries of `localStorage`
        // under the app's prefix. 1 when done, 0 when the browser refused
        // (the error handed over with `nsh_storage_reply`).
        storage_load: (pp, pl) => this.storage(() => {
          const prefix = this.str(pp, pl);
          this.followStorage(prefix);
          const entries = Object.create(null);
          for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key?.startsWith(prefix)) entries[key.slice(prefix.length)] = localStorage.getItem(key);
          }
          return JSON.stringify(entries);
        }),
        storage_set: (pp, pl, kp, kl, vp, vl) =>
          this.storage(() => localStorage.setItem(this.str(pp, pl) + this.str(kp, kl), this.str(vp, vl))),
        storage_remove: (pp, pl, kp, kl) =>
          this.storage(() => localStorage.removeItem(this.str(pp, pl) + this.str(kp, kl))),
        storage_clear: (pp, pl) => this.storage(() => {
          const prefix = this.str(pp, pl);
          const keys = [];
          for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key?.startsWith(prefix)) keys.push(key);
          }
          for (const key of keys) localStorage.removeItem(key);
        }),
      },
    };
    // One request either way: a host that does not serve exactly
    // `application/wasm` (streaming compilation rejects any other type,
    // parameters such as `; charset=utf-8` included) gets the body compiled
    // whole instead of streamed.
    const response = await (typeof url === "string" || url instanceof URL ? fetch(url) : url);
    const type = response.headers.get("Content-Type")?.trim().toLowerCase();
    const module = type === "application/wasm" && WebAssembly.compileStreaming
      ? await WebAssembly.compileStreaming(response)
      : await WebAssembly.compile(await response.arrayBuffer());
    const glue = glueLoad && (await glueLoad);
    if (glue) {
      if (typeof glue.__nsh_imports !== "function" || typeof glue.__nsh_finalize !== "function") {
        throw new Error(`the glue ${this.options.glue} exports no __nsh_imports / __nsh_finalize: it must be the glue the nsh CLI adapts (nsh-bindgen.js), not wasm-bindgen's own output`);
      }
      // NSH's own imports (`nsh`, `env`) stay these.
      for (const [name, fields] of Object.entries(glue.__nsh_imports())) {
        imports[name] = name in imports ? { ...fields, ...imports[name] } : fields;
      }
    }
    // A module that links wasm-bindgen without calling JS through it (the
    // compiler's dependencies, oxc-browserslist's dates; a crate's default
    // features) imports intrinsics it never calls here: stubs that say so
    // if they are.
    for (const { module: name, name: field, kind } of WebAssembly.Module.imports(module)) {
      if (kind !== "function" || imports[name]?.[field]) continue;
      imports[name] ??= {};
      imports[name][field] = () => {
        throw new Error(`nsh.wasm called ${name}.${field}, which the web runtime does not provide`);
      };
    }
    if (WebAssembly.Module.imports(module).some(entry => entry.module === "nsh_browser")) {
      const { createBrowserHost } = await import("./browser/runtime.js");
      this.browserHost = createBrowserHost(this);
      imports.nsh_browser = this.browserHost.imports;
    }
    imports.__wbindgen_placeholder__ && (imports.__wbindgen_placeholder__.__wbindgen_describe = () => {});
    const instance = await WebAssembly.instantiate(module, imports);
    this.wasm = this.browserHost ? this.browserHost.bind(instance.exports) : instance.exports;
    // What side modules import (`main`): the instance's own exports.
    this.mainExports = instance.exports;
    this.sideLoads = new Map();
    // Side modules compiled ahead (`prefetchSides`), by name.
    this.sideModules = new Map();
    this.trapped = false;
    // The glue's own setup (its view of the memory, wasm-bindgen's tables)
    // before any of the app's code runs.
    glue?.__nsh_finalize(instance, module);
    // The parts of `nsh/base`, the standard modules, the features
    // (shaders) and an app's own UI sets this runtime has:
    // one linked for an app (`nsh package`) exports only those it uses.
    for (const name of Object.keys(instance.exports)) {
      if (/^nsh_(part|std|feature|ui_set)_/.test(name)) instance.exports[name]();
    }
    // An app's own runtime (Rust components: nsh.json "rust") registers
    // its UI sets before anything starts.
    this.wasm.nsh_app_init?.();
    // Relative request URLs (`fetch("/api")`) are the page's, as in the
    // browser, as it was when the player started.
    this.withStrings([this.baseURL], (p, l) => this.wasm.nsh_set_base_url(p, l));
    new ResizeObserver(() => this.resized()).observe(this.root);
    matchMedia("(prefers-color-scheme: dark)").addEventListener("change", (e) => {
      if (this.options.dark === undefined) this.setDark(e.matches);
    });
    this.installEnvironment();
    this.installInput();
  }

  // Side modules --------------------------------------------------------

  /**
   * Loads the side modules `names` (as `nsh package --target web` maps
   * them per chunk: the parts of `nsh/base`, standard modules and features
   * the main module was published without) in parallel, each after the
   * side modules it imports from, and calls each gate once. `table` is the
   * page's `sides`: by name, `{ url, gate?, needs, onDemand? }` (`onDemand`:
   * only a load that needs it, a chunk's or `loadData`'s, fetches it;
   * `nsh package` marks every side module it writes so). A page awaits it
   * before a chunk that needs them runs (its `prepareChunk`).
   */
  loadSides(names, table) {
    return Promise.all((names ?? []).map((name) => this.loadSide(name, table)));
  }

  /**
   * Downloads and compiles every side module of `table` in the background,
   * at a low priority, so the main module and the app's first screen come
   * first. Failures here are left to the load that needs the module,
   * which tries again. `preloadSides` then instantiates them.
   */
  prefetchSides(table) {
    const names = Object.keys(table ?? {}).filter((name) => !table[name].onDemand);
    for (const name of names) {
      if (this.sideModules.has(name) || this.sideLoads.has(name)) continue;
      const compiled = this.compileSide(table[name].url, { priority: "low" });
      compiled.catch(() => {
        if (this.sideModules.get(name) === compiled) this.sideModules.delete(name);
      });
      this.sideModules.set(name, compiled);
    }
  }

  /**
   * Instantiates every side module of `table` once the browser is idle
   * (call it after the app started), so a screen that needs one finds its
   * components registered.
   */
  preloadSides(table) {
    const names = Object.keys(table ?? {}).filter((name) => !table[name].onDemand);
    if (!names.length) return;
    const idle = globalThis.requestIdleCallback ?? ((f) => setTimeout(f, 200));
    idle(() => this.loadSides(names, table).catch((err) => console.warn(`[nsh] preloading side modules: ${err?.message ?? err}`)));
  }

  async compileSide(url, init) {
    try {
      return await WebAssembly.compileStreaming(fetch(url, init));
    } catch (err) {
      // Served without `application/wasm`: compiled from its bytes.
      if (!(err instanceof TypeError)) throw err;
      const response = await fetch(url, init);
      if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
      return WebAssembly.compile(await response.arrayBuffer());
    }
  }

  /**
   * The exports of side module `name`, once it and what it needs loaded.
   * Callers share one load; a failed one (the network, a server error) is
   * forgotten, so the next load that needs the module tries again, while
   * the side modules it needs that did load stay loaded.
   */
  loadSide(name, table) {
    let load = this.sideLoads.get(name);
    if (!load) {
      const side = table?.[name];
      if (!side) return Promise.reject(new Error(`no side module ${name}`));
      load = this.instantiateSide(name, side, table);
      this.sideLoads.set(name, load);
      load.catch(() => {
        if (this.sideLoads.get(name) === load) this.sideLoads.delete(name);
      });
    }
    return load;
  }

  async instantiateSide(name, { url, gate, needs }, table) {
    const imports = { main: this.mainExports };
    const from = await Promise.all((needs ?? []).map((need) => this.loadSide(need, table)));
    (needs ?? []).forEach((need, i) => { imports[need] = from[i]; });
    // Compiled ahead when it was prefetched; else now, at full priority.
    const ahead = this.sideModules.get(name);
    this.sideModules.delete(name);
    const module = await (ahead?.catch(() => null) ?? null) ?? await this.compileSide(url);
    const instance = await WebAssembly.instantiate(module, imports);
    if (gate) {
      const register = instance.exports[gate];
      if (typeof register !== "function") throw new Error(`${url} exports no ${gate}`);
      register();
      this.afterGate(gate);
    }
    return instance.exports;
  }

  /**
   * What the runtime does once a gate ran after the app started: makes
   * what it registered visible to the running engines.
   */
  afterGate(gate) {
    if (typeof this.wasm.nsh_after_gate !== "function") return;
    this.withStrings([gate], (p, l) => this.wasm.nsh_after_gate(p, l));
  }

  // Tests ---------------------------------------------------------------

  /**
   * A test session runs (`nsh test --target web`): the module keeps the
   * model of the app its agent asks about, from the next bundle on.
   */
  testStart() {
    // The apps started from now on send their requests to the test
    // (`web/browser/fetch.js`, `web/browser/testing.js`).
    this.testing = true;
    this.wasm.nsh_test_start?.();
  }

  /**
   * What the test sets the app up with (`ServerMessage::TestSetup`): the
   * storage it starts with, whether it traces the app, and what it fixes of
   * the environment and the clipboard. Its requests,
   * and a traced app's batches, then go to the test through `onTestSend`
   * (`{type: "fetch", id, request}`, `{type: "fetch_cancel", id}`,
   * `{type: "trace", items}`).
   */
  testSetup(storage, trace, environment) {
    // The idiom the test asks for (`open`'s desktop `platform`), in place
    // of the measured one, for the apps started from now on.
    this.testIdiom = environment?.idiom;
    if (!this.wasm.nsh_test_setup) return;
    const setup = JSON.stringify({ storage: storage ?? [], trace: !!trace, environment: environment ?? {} });
    this.withStrings([setup], (p, l) => this.wasm.nsh_test_setup(p, l));
  }

  /** The test's answer to the app's request `id` (`ServerMessage::Fetch`). */
  testFetchReply(id, reply) {
    if (!this.wasm.nsh_test_fetch_reply) return;
    this.withStrings([JSON.stringify({ id, reply })], (p, l) => this.wasm.nsh_test_fetch_reply(p, l));
  }

  /** Whether this runtime answers test steps (the development host's). */
  get takesTests() {
    return typeof this.wasm?.nsh_test_answer === "function";
  }

  /**
   * Answers a test step (`nsh_dev::protocol::TestStep`) as an
   * `nsh_dev::protocol::StepOutcome`: the module's model answers what it
   * knows of the app, the page's views where they are.
   */
  testStep(step) {
    if (!this.takesTests) return { outcome: "failed", message: "this runtime takes no test steps" };
    const len = this.withStrings([JSON.stringify(step)], (p, l) => this.wasm.nsh_test_answer(p, l));
    const answer = JSON.parse(this.str(this.wasm.nsh_test_answer_ptr(), len));
    if (step.query?.query === "animating" && "done" in answer) {
      // The native graph's, or the page's own (a screen sliding in, a
      // dialog fading): a finite animation still running.
      return { outcome: "done", value: answer.done === true || this.pageAnimating() };
    }
    if ("done" in answer) return { outcome: "done", value: answer.done ?? null };
    if ("failed" in answer) return { outcome: "failed", message: answer.failed };
    try {
      return { outcome: "done", value: this.testPage(step.query ?? {}) };
    } catch (e) {
      return { outcome: "failed", message: String(e?.message ?? e) };
    }
  }

  /** Whether a finite CSS or Web Animations animation of the app runs. */
  pageAnimating() {
    return this.root.getAnimations({ subtree: true }).some((a) => {
      if (a.playState !== "running") return false;
      const end = a.effect?.getComputedTiming().endTime;
      return end != null && Number.isFinite(Number(end));
    });
  }

  /** What only the page's views answer of a test agent's question. */
  testPage(query) {
    switch (query.query) {
      case "bounds": {
        // CSS pixels from the viewport's top left: what the browser's input
        // (the DevTools protocol's) takes.
        const el = this.views.get(query.id);
        if (!el?.isConnected) return null;
        const r = el.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) return null;
        return [r.left, r.top, r.width, r.height];
      }
      case "viewport":
        return [window.innerWidth, window.innerHeight];
      case "text_bounds": {
        // Characters `start..end` of a text view: their first box (on their
        // first line), as the other platforms answer.
        const el = this.views.get(query.id);
        if (!el?.isConnected) return null;
        for (const run of el.querySelectorAll(":scope > .nsh-run")) {
          if (run._start == null) continue;
          const from = Math.max(query.start - run._start, 0);
          const to = Math.min(query.end - run._start, run.textContent.length);
          if (from >= to) continue;
          const range = document.createRange();
          range.setStart(...runPoint(run, from));
          range.setEnd(...runPoint(run, to));
          const r = range.getBoundingClientRect();
          return [r.left, r.top, r.width, r.height];
        }
        return null;
      }
      case "input_text": {
        const field = this.views.get(query.id)?._field;
        return field ? field.value : null;
      }
      case "dialog_point": {
        const backdrops = this.root.querySelectorAll(".nsh-dialog-backdrop");
        const backdrop = backdrops[backdrops.length - 1];
        if (!backdrop) throw new Error("no dialog is shown");
        if (query.button == null) {
          // Outside its card: the backdrop's corner.
          const r = backdrop.getBoundingClientRect();
          return [r.left + 2, r.top + 2];
        }
        const button = [...backdrop.querySelectorAll("button")].find((b) => b.textContent.trim() === query.button);
        if (!button) throw new Error(`the dialog has no button ${JSON.stringify(query.button)}`);
        const r = button.getBoundingClientRect();
        return [r.left + r.width / 2, r.top + r.height / 2];
      }
    }
    throw new Error(`the page cannot answer ${JSON.stringify(query)}`);
  }

  // Memory --------------------------------------------------------------

  str(ptr, len) {
    return decoder.decode(new Uint8Array(this.wasm.memory.buffer, ptr, len));
  }

  bytes(ptr, len) {
    return new Uint8Array(this.wasm.memory.buffer, ptr, len);
  }

  /**
   * Runs a `localStorage` call for the app's storage: 1 and what `f`
   * returned (a string) handed over, or 0 and the error.
   */
  storage(f) {
    let reply, done;
    try {
      reply = f();
      done = 1;
    } catch (e) {
      reply = String(e?.message ?? e);
      done = 0;
    }
    if (typeof reply === "string") this.withStrings([reply], (p, l) => this.wasm.nsh_storage_reply(p, l));
    return done;
  }

  /**
   * Follows what other tabs of the origin change in the app's storage,
   * kept under `prefix` (`storage_load`): a tab gets a `storage` event for
   * each `localStorage` change the others make, never for its own.
   */
  followStorage(prefix) {
    (this.storagePrefixes ??= new Set()).add(prefix);
    if (this.storageListener) return;
    this.storageListener = (e) => this.storageChanged(e);
    window.addEventListener("storage", this.storageListener);
  }

  /**
   * Hands the engine a change another tab made to the app's storage: the
   * value this tab reads now rather than the event's `newValue`, which a
   * write this tab made since the other tab's may have replaced. A `key`
   * of null is `localStorage.clear()`: the engine reads the entries again.
   */
  storageChanged(e) {
    let area;
    try {
      area = localStorage;
    } catch {
      return;
    }
    if (e.storageArea !== area) return;
    for (const prefix of this.storagePrefixes) {
      let kind = 2, key = "", value = "";
      if (e.key !== null) {
        if (!e.key.startsWith(prefix)) continue;
        key = e.key.slice(prefix.length);
        try {
          value = area.getItem(e.key);
        } catch {
          continue;
        }
        kind = value === null ? 0 : 1;
      }
      this.call((w) => this.withStrings([prefix, key, value ?? ""], (pp, pl, kp, kl, vp, vl) =>
        w.nsh_storage_changed(pp, pl, kp, kl, vp, vl, kind)));
    }
  }

  /** Calls `f(ptr, len, ...)` for each string, freeing them afterwards. */
  withStrings(strings, f) {
    const passed = strings.map((s) => {
      const data = typeof s === "string" ? encoder.encode(s) : s;
      const ptr = this.wasm.nsh_alloc(data.length);
      new Uint8Array(this.wasm.memory.buffer, ptr, data.length).set(data);
      return [ptr, data.length];
    });
    try {
      return f(...passed.flat());
    } finally {
      for (const [ptr, len] of passed) this.wasm.nsh_dealloc(ptr, len);
    }
  }

  metrics(font) {
    let m = this.metricsCache.get(font);
    if (!m) {
      this.measure.font = font;
      const t = this.measure.measureText("Hg");
      const x = this.measure.measureText("x");
      // Ascent and descent as the DOM draws a run (`.nsh-run`: absolutely
      // placed, `font` shorthand, so `line-height: normal`): where its
      // baseline falls in its box. Canvas rounds its font box to whole
      // pixels (Chrome), each font its own way, which put runs of two fonts
      // on one line up to a pixel and a half apart on a phone.
      const dom = this.domMetrics(font);
      m = dom
        ? [dom[0], dom[1], x.actualBoundingBoxAscent ?? 0]
        : [t.fontBoundingBoxAscent ?? 0, t.fontBoundingBoxDescent ?? 0, x.actualBoundingBoxAscent ?? 0];
      this.metricsCache.set(font, m);
    }
    return m;
  }

  /** `[ascent, descent]` of a run in `font` as the DOM lays it out, or
   * null without a document to measure in. */
  domMetrics(font) {
    if (typeof document === "undefined" || !document.body) return null;
    let probe = this.metricsProbe;
    if (!probe || !probe.box.isConnected) {
      const box = document.createElement("div");
      box.setAttribute("aria-hidden", "true");
      box.style.cssText = "position:absolute;left:-10000px;top:0;visibility:hidden;pointer-events:none";
      const run = document.createElement("span");
      run.className = "nsh-run";
      run.style.cssText = "left:0;top:0";
      run.textContent = "Hg";
      const mark = document.createElement("i");
      mark.style.cssText = "display:inline-block;width:0;height:0;vertical-align:baseline";
      run.append(mark);
      box.append(run);
      document.body.append(box);
      probe = this.metricsProbe = { box, run, mark };
    }
    probe.run.style.font = font;
    const top = probe.run.getBoundingClientRect();
    const ascent = probe.mark.getBoundingClientRect().top - top.top;
    if (!(top.height > 0)) return null;
    return [ascent, top.height - ascent];
  }

  /**
   * A face registered from data loads asynchronously: text is measured
   * again once it can be drawn. Faces registered while the app starts hide
   * it until they load, so its first frame shows the right fonts.
   */
  fontLoading(loading) {
    const pending = (this.fontsPending ??= []);
    pending.push(loading.catch((err) => console.warn("[nsh] font failed to load:", err)));
    if (this.starting && !this.root.classList.contains("nsh-hidden")) {
      this.root.classList.add("nsh-hidden");
      // A face that never settles must not keep the app hidden.
      clearTimeout(this.fontTimer);
      this.fontTimer = setTimeout(() => this.root.classList.remove("nsh-hidden"), 3000);
    }
    if (pending.length > 1) return;
    const settle = () => {
      // A copy: faces registered while these load join `fontsPending`, and
      // must be found there when these are done.
      const waiting = [...this.fontsPending];
      Promise.all(waiting).then(() => {
        if (this.fontsPending.length > waiting.length) {
          this.fontsPending = this.fontsPending.slice(waiting.length);
          settle();
          return;
        }
        this.fontsPending = [];
        this.metricsCache.clear();
        this.call((w) => w.nsh_fonts_loaded());
        clearTimeout(this.fontTimer);
        this.root.classList.remove("nsh-hidden");
      });
    };
    settle();
  }

  // Running -------------------------------------------------------------

  /**
   * Runs the app whose entry module is at `entry` (a URL, relative to the
   * page) with the browser's ES module loader, replacing what ran; settles
   * once the entry module ran. Options: `appId` (`nsh.json` `"id"`: the
   * app's storage is kept under it; without one, under the page's path),
   * `capabilities` (the app's `capabilities.json`), `chunks` (a split
   * bundle's chunk ids, relative to the entry, to their URLs) and
   * `imports` (more import map entries).
   */
  runModule(entry, options) {
    if (!this.browserHost) return Promise.reject(new Error("this runtime has no browser JavaScript host"));
    return this.browserHost.run(entry, options);
  }

  /**
   * Runs `code`, an ES module given as source text (a development bundle
   * from the dev server, a compiled playground module), as `runModule`
   * does; settles once it ran. Options: `appId` and `capabilities` (as in
   * `runModule`), `sourceMap` (JSON: inlined, so DevTools shows the
   * original sources) and `name` (what DevTools calls the module).
   */
  runSource(code, { appId = "", capabilities = "", sourceMap = "", name = "" } = {}) {
    if (!this.browserHost) return Promise.reject(new Error("this runtime has no browser JavaScript host"));
    return this.browserHost.runSource(code, { appId, capabilities, sourceMap, name });
  }

  /**
   * Runs the Rust app the module was built for (an app's runtime with
   * `nsh.json` `"root"`): its root component, with no bundle and no JS of
   * the app's, replacing what ran.
   */
  runRust() {
    if (!this.wasm.nsh_start_rust) throw new Error("this runtime has no Rust app");
    const [width, height] = this.reset();
    this.begin(width, (environment) => {
      this.withStrings([environment], (p, l) => this.wasm.nsh_environment(p, l));
      return this.wasm.nsh_start_rust(width, height, this.dark ? 1 : 0, devicePixelRatio || 1);
    });
  }

  /** Stops what ran and empties the root; its size. */
  reset() {
    this.stop();
    this.audioDispose();
    this.askBeforeLeaving(false);
    this.watchPageEnd(false);
    this.resetHistory();
    // The next app sets its own (its first commit comes before the write).
    if (this.windowTitle) {
      this.windowTitle = null;
      this.syncTitleSoon();
    }
    this.app = (this.app ?? 0) + 1;
    const root = this.root;
    root.textContent = "";
    root.append(this.live);
    this.views.clear();
    this.mouseTracked.clear();
    this.wheelTracked.clear();
    root._id = ROOT_ID;
    root._kind = "root";
    root._events = new Set();
    root._animation = {};
    this.views.set(ROOT_ID, root);
    const width = root.clientWidth || 390;
    const height = root.clientHeight || 844;
    this.size = [width, height];
    return this.size;
  }

  /** Starts the app with `start(environment)`, which returns the pump delay. */
  begin(width, start, deferEvents = false) {
    this.idiom = this.options.idiom ?? this.testIdiom ?? this.measureIdiom();
    const environment = (this.reported = JSON.stringify(this.environment()));
    this.updateRootClasses();
    // Host events wait for this app's top-level `host.on` listeners, not
    // the replaced app's; those queued after a failed start are dropped.
    this.started = false;
    this.hostEvents ??= [];
    // Fonts registered while it starts hold its first frame back (`fontLoading`).
    this.starting = true;
    // The page's end is the app's (`watchPageEnd`).
    this.watchPageEnd(true);
    // The app's address starts as its first entry's, which the core has
    // before the app's code runs (`nsh_set_page_url`).
    if (this.history) this.withStrings([this.firstUrl], (p, l) => this.wasm.nsh_set_page_url?.(p, l));
    try {
      this.call(() => start(environment));
    } catch (err) {
      // Only a trap (a panic) throws: no app runs to take events.
      this.hostEvents = null;
      throw err;
    } finally {
      this.starting = false;
    }
    // The new engine's overlays go over the window too.
    if (this.viewportOverlays) {
      this.floatArea = null;
      this.placeFloats();
    }
    if (!deferEvents) this.startedApp();
  }

  /** Delivers queued host events after the app installs its listeners. */
  startedApp() {
    this.started = true;
    const events = this.hostEvents;
    this.hostEvents = [];
    for (const json of events) this.eventJson(ROOT_ID, "onHost", json);
  }

  /**
   * Fetches the runtime's data `name` (`nsh-<name>.bin`, or the URL
   * `data[name]` names) and hands it to the engine; a file that is missing
   * or does not load is handed over as none (the code it would highlight
   * stays plain). The code of the gate `nsh_feature_<name>`, if any, comes
   * first: a side module, or an export of a module published whole.
   */
  async loadData(name) {
    const url = this.data?.[name] ?? new URL(`nsh-${name}.bin`, import.meta.url);
    let bytes = null;
    try {
      const gate = `nsh_feature_${name}`;
      if (this.options.sides?.[gate]) await this.loadSide(gate, this.options.sides);
      else this.wasm[gate]?.();
      const response = await fetch(url);
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`.trim());
      bytes = new Uint8Array(await response.arrayBuffer());
    } catch (err) {
      console.warn("[nsh]", `${err.message ?? err} (${url})`);
    }
    const data = bytes ?? new Uint8Array(0);
    this.call((w) => this.withStrings([name, data], (np, nl, dp, dl) => w.nsh_data(np, nl, dp, dl, bytes ? 1 : 0)));
  }

  /**
   * Compiles one TSX module to what `runSource` takes, in the page (only
   * with `nsh-playground.wasm`): `{ code }` or `{ error }` (with a code
   * frame).
   */
  compile(source, name = "App.tsx") {
    if (!this.wasm.nsh_compile) return { error: "this runtime has no compiler (load nsh-playground.wasm)" };
    const ok = this.withStrings([name, source], (np, nl, sp, sl) => this.wasm.nsh_compile(np, nl, sp, sl));
    const text = this.str(this.wasm.nsh_compiled_ptr(), this.wasm.nsh_compiled_len());
    return ok ? { code: text } : { error: text };
  }

  /**
   * Compiles `source` (one TSX module named `name`) and runs it with
   * `runSource`'s `options`: a promise of the compile error (with a code
   * frame), or of null once the module ran. An error the module throws as
   * it runs is shown as the app's errors are, and rejects the promise.
   */
  async compileAndRun(source, name = "App.tsx", options = {}) {
    const result = this.compile(source, name);
    if (result.error) return result.error;
    await this.runSource(result.code, { name, ...options });
    return null;
  }

  /**
   * Applies a hot update from the dev server (a script replacing changed
   * modules) to the running development bundle: a promise of whether it
   * was applied in place (false: run the new bundle instead). An update
   * whose code throws is shown as the app's errors are; the app keeps the
   * modules that ran, and the next update can fix the rest.
   */
  hotUpdate(code, name = "hot.js", sourceMap = "") {
    if (!this.browserHost) return Promise.resolve(false);
    return this.browserHost.hotUpdate(code, name, sourceMap ?? "");
  }

  stop() {
    if (this.stopping) return;
    this.stopping = true;
    try {
    // Host events wait for the next app (`begin`).
    this.started = false;
    this.hostEvents ??= [];
    this.frameSession?.close();
    this.viewportPageRelease?.(); this.viewportPageRelease = null;
    for (const layer of this.frameLayers ?? []) layer.remove();
    this.frameLayers?.clear();
    if (this.viewportDialogs) this.dialogs = [];
    this.viewportObserver?.disconnect();
    for (const el of this.floats ?? []) this.sinkFloat(el);
    this.floats = [];
    this.fileOperations.clear();
    for (const id of [...this.requests.keys()]) this.fetchCancel(id);
    for (const id of [...this.websockets.keys()]) this.websocketCancel(id);
    clearTimeout(this.timer);
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    clearTimeout(this.keeper?.timer);
    this.keeper = null;
    this.browserHost?.stop();
    this.storagePrefixes?.clear();
    if (this.storageListener) window.removeEventListener("storage", this.storageListener);
    this.storageListener = null;
    this.wasm?.nsh_stop();
    } finally { this.stopping = false; }
  }

  /**
   * The engine has work that came outside a call into it (`request_pump`:
   * a task a browser callback woke, or what a pump left for the next): one
   * `nsh_pump` in a task of its own, however many ask before it runs;
   * `call` defers it if the engine runs.
   */
  requestPump() {
    if (this.pumpRequested) return;
    this.pumpRequested = true;
    setTimeout(() => {
      this.pumpRequested = false;
      this.call((w) => w.nsh_pump());
    }, 0);
  }

  /** The engine is due again in `delay` ms (-1: only for input). */
  schedule(delay) {
    clearTimeout(this.timer);
    if (delay >= 0) this.timer = setTimeout(() => this.call((w) => w.nsh_pump()), Math.max(0, delay));
  }

  /**
   * Calls into the engine (`f(exports)` returns its next pump delay). The
   * engine is not reentrant: a call made while it runs (from a batch being
   * applied) waits until it returns. After a trap (a panic) it takes no
   * calls: the trap left it in the middle of one, its state still borrowed,
   * so each later call would only panic again (`reportPanic` keeps the
   * first panic's report on screen whichever entry a later one comes from).
   */
  call(f) {
    if (this.trapped) return;
    if (this.depth > 0) {
      (this.deferred ??= []).push(f);
      return;
    }
    this.depth = 1;
    try {
      this.schedule(f(this.wasm));
    } catch (err) {
      if (err instanceof WebAssembly.RuntimeError) this.trap();
      throw err;
    } finally {
      this.depth = 0;
    }
    const deferred = this.deferred;
    if (deferred?.length) {
      this.deferred = [];
      for (const g of deferred) this.call(g);
    }
  }

  /** The engine wants a frame (`request_frame`): the native animations
   * run, or JS asked for one. */
  requestFrame() {
    this.deadlineSoon();
    if (this.frame) return;
    this.frame = requestAnimationFrame((now) => {
      this.frame = 0;
      this.frameAt = performance.now();
      this.call((w) => w.nsh_frame(this.frameTime(now), 1));
    });
  }

  /**
   * The time an animation frame steps the native animations at: the
   * frame's (when it began, so the steps keep the display's pace), unless a
   * task held the frame, and then when its callbacks run. A press handled
   * before them runs the app's code, which may mount a sheet and start its
   * entrance; stepped at the frame's time, that entrance would start before
   * it was asked for, and its first drawn step would be as far along as the
   * press took (a slow one showed the sheet nearly in place). Never earlier
   * than the frame before.
   */
  frameTime(now) {
    const at = this.frameAt - now > FRAME_HELD_MS ? this.frameAt : now;
    this.steppedAt = Math.max(at, this.steppedAt ?? at);
    return this.steppedAt;
  }

  /** `keepDeadline` once the call into the engine that asked for a frame
   * is over: the engine is not reentrant, and one look after however many
   * asked in it is enough. */
  deadlineSoon() {
    if (this.deadlineQueued) return;
    this.deadlineQueued = true;
    queueMicrotask(() => {
      this.deadlineQueued = false;
      this.keepDeadline();
    });
  }

  /**
   * Makes what the native animations end happen on time while no
   * animation frames come: browsers run no `requestAnimationFrame` in a
   * hidden tab (nor, often, in an iframe out of view), and an animation
   * must still end and tell the app (`finished`). A timer waits for the
   * graph's next deadline (`nsh_deadline`) and `LATE_MS` more; if no frame
   * ran since it came due, it runs one at the current time, which steps
   * the graph there, ends what ended and gives the next deadline. While
   * frames come it does nothing. Nothing waits for what only draws (an
   * animation looping forever, a JS frame request), so a hidden page with
   * a spinner does no work. Browsers throttle a hidden page's timers (to
   * about once a second), which an end there can come as late as.
   */
  keepDeadline() {
    if (this.trapped || !this.wasm?.nsh_deadline) return;
    const now = performance.now();
    const at = this.wasm.nsh_deadline(now);
    if (at < 0) return;
    // One timer at a time: the one waiting for an earlier deadline
    // schedules the next when it fires.
    if (this.keeper && this.keeper.at <= at) return;
    clearTimeout(this.keeper?.timer);
    const keeper = { at, timer: 0 };
    keeper.timer = setTimeout(() => {
      if (this.keeper !== keeper) return;
      this.keeper = null;
      if (!(this.frameAt >= at)) {
        this.frameAt = performance.now();
        this.call((w) => w.nsh_frame(this.frameAt, 0));
      }
      this.keepDeadline();
    }, Math.max(0, at + LATE_MS - now));
    this.keeper = keeper;
  }

  resized() {
    const width = this.root.clientWidth;
    const height = this.root.clientHeight;
    if (!this.size || !width || (width === this.size[0] && height === this.size[1])) return;
    this.size = [width, height];
    this.call((w) => w.nsh_resize(width, height));
    this.environmentChanged();
    if (this.viewportOverlays) this.placeFloats();
    for (const el of this.views.values()) if (el._kind === "modal" && el.isConnected && !el._leaving) this.placeModal(el);
  }

  // Environment ---------------------------------------------------------

  /**
   * The kind of device, decided when an app starts (it never changes while
   * it runs, as on every platform): a mouse (a fine pointer that hovers)
   * makes a desktop at any width, as a narrow window does on the native
   * desktops, a touch screen whose short side is at least 600 a tablet,
   * the rest a phone.
   */
  measureIdiom() {
    if (matchMedia("(pointer: fine) and (hover: hover)").matches) return "desktop";
    return Math.min(screen.width, screen.height) >= 600 ? "pad" : "phone";
  }

  /** Follows what the page's environment depends on. */
  installEnvironment() {
    const changed = () => this.environmentChanged();
    this.reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
    this.reducedMotion.addEventListener("change", changed);
    // The pixel ratio changes with the page's zoom and the screen: a query
    // for the current one says when it no longer holds.
    const resolution = () => {
      matchMedia(`(resolution: ${devicePixelRatio || 1}dppx)`).addEventListener("change", () => {
        resolution();
        changed();
      }, { once: true });
    };
    resolution();
    addEventListener("languagechange", changed);
    addEventListener("resize", changed);
    // `network()`: the browser going on- and offline, and its link where it
    // names one (`navigator.connection`, Chromium's).
    addEventListener("online", changed);
    addEventListener("offline", changed);
    navigator.connection?.addEventListener?.("change", changed);
    // `lifecycle()`: hidden (another tab, a minimized window) or without
    // the focus. The time zone (`localeSettings()`) is read again then too: browsers tell no
    // change of the system's zone, which the user makes away from the page.
    document.addEventListener("visibilitychange", changed);
    addEventListener("focus", changed);
    addEventListener("blur", changed);
    this.watchPageCache(changed);
    visualViewport?.addEventListener("resize", changed);
    visualViewport?.addEventListener("scroll", changed);
    new MutationObserver(changed).observe(document.documentElement, { attributes: true, attributeFilter: ["dir", "lang"] });
    // `env(safe-area-inset-*)` is only readable through a style it sets.
    this.safeProbe = document.createElement("div");
    this.safeProbe.className = "nsh-probe";
    document.body.append(this.safeProbe);
    if (this.viewportOverlays) this.installFloats();
  }

  /** A page the browser keeps in its back / forward cache (a `pagehide`
   * that is `persisted`) is in the background until a `pageshow` brings it
   * back: the app sees the pair of edges whether or not the browser tells
   * `visibilitychange` around them. A page that is discarded (`pagehide`
   * not `persisted`) ends its app instead (`watchPageEnd`). Neither
   * listener keeps a page out of that cache. */
  watchPageCache(changed) {
    const cached = (value) => (event) => {
      if (!event.persisted) return;
      this.pageCached = value;
      changed();
    };
    window.addEventListener("pagehide", cached(true));
    window.addEventListener("pageshow", cached(false));
  }

  /** The app's state (`lifecycle()`): `background` while the page is
   * hidden (another tab, a minimized window) or in the back / forward
   * cache, else whether it has the focus. */
  lifecycle() {
    if (this.pageCached || document.visibilityState === "hidden") return "background";
    return document.hasFocus() ? "active" : "inactive";
  }

  /** The page's insets covered by system UI, where they overlap the root
   * (or the client rectangle `r`). */
  safeArea(r = this.root.getBoundingClientRect()) {
    const cs = getComputedStyle(this.safeProbe);
    const px = (v) => parseFloat(v) || 0;
    return [
      Math.max(0, px(cs.paddingTop) - r.top),
      Math.max(0, px(cs.paddingRight) - (innerWidth - r.right)),
      Math.max(0, px(cs.paddingBottom) - (innerHeight - r.bottom)),
      Math.max(0, px(cs.paddingLeft) - r.left),
    ].map(Math.round);
  }

  /**
   * How much of the root the on-screen keyboard covers: mobile browsers
   * shrink the visual viewport under it, not the layout (0 while zoomed).
   */
  keyboardHeight() {
    const vv = visualViewport;
    if (!vv || vv.scale > 1.01) return 0;
    const bottom = this.root.getBoundingClientRect().bottom;
    return Math.max(0, Math.round(bottom - (vv.offsetTop + vv.height)));
  }

  /** What the page knows about the user and the device (`nsh_environment`). */
  environment() {
    const languages = navigator.languages?.length ? navigator.languages : [navigator.language];
    const locale = languages.find(Boolean) ?? Intl.DateTimeFormat().resolvedOptions().locale;
    const dir = document.documentElement.getAttribute("dir");
    // The root's font size is the browser's default text size unless the
    // page sets one: 16px at 100%.
    const fontSize = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    return {
      idiom: this.idiom,
      locale,
      // The browser's preferred languages (`localeSettings()`), the locale's
      // first; `languagechange` tells their changes.
      languages: [...new Set([locale, ...languages.filter(Boolean)])],
      regional: regional(locale),
      rtl: dir === "rtl" || dir === "ltr" ? dir === "rtl" : rightToLeft(locale),
      reduceMotion: this.reducedMotion.matches,
      fontScale: Math.round(fontSize / 16 * 100) / 100,
      pixelRatio: devicePixelRatio || 1,
      safeArea: this.safeArea(),
      keyboard: this.keyboardHeight(),
      appleKeyboard: APPLE,
      host: Boolean(this.options.host),
      lifecycle: this.lifecycle(),
      network: webNetwork(),
      timeZone: timeZoneName(),
      screenColor: typeof window.EyeDropper === "function",
      // `writeClipboard` reports each write's result.
      clipboardWriteResult: true,
      share: webShareAllowed(),
      notifications: typeof window.Notification === "function",
      audio: typeof (window.AudioContext ?? window.webkitAudioContext) === "function",
      // Shader views draw until the first one finds no WebGL 2 (`shaderGl`).
      shaders: this._shaderGl !== null,
    };
  }

  /** Reports the environment if it changed since it was last reported. */
  environmentChanged() {
    if (!this.reported) return;
    this.updateRootClasses();
    const json = JSON.stringify(this.environment());
    if (json === this.reported) return;
    this.reported = json;
    this.call(() => this.withStrings([json], (p, l) => this.wasm.nsh_environment(p, l)));
  }

  setDark(dark) {
    this.dark = dark;
    this.updateRootClasses();
    this.call((w) => w.nsh_set_dark(dark ? 1 : 0));
  }

  event(id, name, payload = null) {
    this.eventJson(id, name, JSON.stringify(payload));
  }

  /** {@link event} with its payload already serialized. */
  eventJson(id, name, json) {
    this.call(() => this.withStrings([name, json], (np, nl, pp, pl) =>
      this.wasm.nsh_event(id, np, nl, pp, pl)));
  }

  /**
   * The engine panicked (its panic hook): it traps once this returns, its
   * state still borrowed. The first panic's report stays on screen; what
   * comes after, from any entry into the engine (a pump, an event, the
   * app's own timers calling into it in the browser runtime), only panics
   * again over the borrowed state, so it goes to the console.
   */
  reportPanic(message) {
    const first = !this.trapped;
    this.trap();
    this.showError(message, { overlay: first });
  }

  /** Stops calling an engine that trapped (`call`, `reportPanic`). */
  trap() {
    this.trapped = true;
    this.deferred = [];
    clearTimeout(this.timer);
    // Nothing of the app's can run any more (save, quit): the page leaves
    // as any other.
    this.askBeforeLeaving(false);
    this.watchPageEnd(false);
  }

  showError(message, { overlay = !this.trapped } = {}) {
    console.error("[nsh]", message);
    this.options.onError?.(message);
    // After a panic the overlay keeps its report (`reportPanic`).
    if (this.options.overlay === false || !overlay) return;
    let box = this.root.querySelector(":scope > .nsh-error");
    if (!box) {
      box = document.createElement("div");
      box.className = "nsh-error";
      box.title = "Click to dismiss";
      box.addEventListener("click", () => box.remove());
      this.root.append(box);
    }
    // The Copy button copies the whole error (for pasting into a report or an AI chat).
    const copy = document.createElement("button");
    copy.className = "nsh-error-copy";
    copy.textContent = "Copy";
    copy.addEventListener("click", (event) => {
      event.stopPropagation();
      navigator.clipboard?.writeText(message).then(() => { copy.textContent = "Copied"; }, () => {});
    });
    box.replaceChildren(copy, message);
  }

  /** Loads `img` from `src`, the address of `uri`: an app's asset from
   * another origin (a packaged site's `--asset-url`) as a CORS image, so a
   * canvas and a transition's snapshot may still draw it. */
  setImageSource(img, uri, src) {
    const asset = uri?.startsWith("asset:/") && new URL(src, location.href).origin !== location.origin;
    if (asset) img.crossOrigin = "anonymous";
    else img.removeAttribute("crossorigin");
    img.src = src;
  }

  asset(uri) {
    if (!uri) return uri;
    if (uri.startsWith("asset:/")) {
      const path = uri.slice("asset:/".length).replace(/^\/+/, "");
      return this.assets?.[path] ?? this.assetBase + path;
    }
    // An in-memory image: its bytes came with `image_bytes`.
    const inline = this.inlineImages.get(uri);
    if (inline) return inline;
    // A relative URL is the page's as the player started (`baseURL`), as
    // the app's requests are.
    return /^[a-z][a-z\d+.-]*:/i.test(uri) ? uri : new URL(uri, this.baseURL).href;
  }

  // Mounting ------------------------------------------------------------

  apply(batch) {
    for (const item of batch) {
      const handler = this[`op_${item[0]}`];
      if (handler) handler.call(this, item);
    }
    this.endLayoutAnimation();
    if (this.changedStacks.size) this.reconcileStacks();
    if (this.removals.length) this.finishRemovals();
    if (this.readingHosts?.size) this.orderReading();
    if (this.relating?.size) this.linkRelations();
    if (this.viewportOverlays) this.syncFloats();
    if (this.autoFocusing?.size) this.focusAppeared();
  }

  /** The `autoFocus` inputs the batch put in the page take the focus now,
   * in the turn that applied it: a batch an event's handler made is still
   * in that event, where iOS Safari raises the keyboard for a focus (and
   * only there: not from a timer after it). One not in the page yet (its
   * container comes in a later batch) waits for that batch; one removed
   * meanwhile is forgotten. Like a focus command's, the focus is this
   * press's (`pressFocus`): the mouse events the browser makes of a touch
   * would otherwise take it away, the finger being over the views the
   * press replaced. */
  focusAppeared() {
    for (const el of this.autoFocusing) {
      if (this.views.get(el._id) !== el) {
        this.autoFocusing.delete(el);
        continue;
      }
      if (!el.isConnected) continue;
      this.autoFocusing.delete(el);
      el._field?.focus();
      this.pressFocus = el._field ?? null;
    }
  }

  /** The DOM id of view `id`: unique on the page, beside other players. */
  domId(id) {
    return `${this.classPrefix}v${id}`;
  }

  /** The views that name others (`aria-activedescendant`,
   * `aria-controls`, `aria-describedby`) point at them by DOM id, after
   * the batch made them: a row may be made after the field naming it. A
   * view named that is not there yet is looked for again after the next
   * batch. */
  linkRelations() {
    const pending = this.relating;
    this.relating = null;
    for (const el of pending) {
      if (el.isConnected === false) continue;
      const p = el._props ?? {};
      // The element that keeps the focus: an input's field.
      const focused = el._field ?? el;
      for (const [name, id] of [
        ["aria-activedescendant", p.activeDescendant],
        ["aria-controls", p.controls],
        ["aria-describedby", p.describedBy],
      ]) {
        if (focused !== el) el.removeAttribute(name);
        const target = id == null ? null : this.view(id);
        if (!target) {
          focused.removeAttribute(name);
          if (id != null) (this.relating ??= new Set()).add(el);
          continue;
        }
        if (!target.id) target.id = this.domId(id);
        focused.setAttribute(name, target.id);
      }
    }
  }

  /** `el` was placed or added in `parent`: when that is a scroll view's
   * content, its reading order is set again after the batch. */
  readingChanged(parent) {
    if (!READING_ORDER || !parent) return;
    // A sticky cell is in a track among the other cells.
    const host = parent._list ? parent.parentNode : parent;
    if (host && (host._kind === "scroll" || host._screenOrder || host.classList.contains("nsh-layer"))) (this.readingHosts ??= new Set()).add(host);
  }

  /** Tab and screen readers go through a scroll view's content in the
   * order it is on screen, along the scroll axis, then across it, as on
   * the other platforms. A list's recycled cells stay where they were
   * made in the DOM, which is also the order they paint in, so the DOM is
   * not in their rows' order: `reading-order` gives the rows' order
   * without moving them (a move would blur a focused field, restart
   * animations and reload frames inside them). */
  orderReading() {
    for (const host of this.readingHosts) {
      const scroll = host._kind === "scroll" || host._screenOrder ? host : host.parentNode;
      const horizontal = scroll?._screenOrder ? scroll._screenOrder === "horizontal" : !!scroll?._horizontal;
      const kids = [];
      for (const child of host.children) {
        const f = (child._list ? child.firstElementChild : child)?._frame;
        if (f && (child._id !== undefined || child._list)) kids.push(horizontal ? [f[0], f[1], child] : [f[1], f[0], child]);
      }
      kids.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
      if (host.style.readingFlow !== "source-order") host.style.readingFlow = "source-order";
      kids.forEach(([, , child], i) => {
        if (child._readingOrder === i) return;
        child._readingOrder = i;
        child.style.readingOrder = String(i);
      });
    }
    this.readingHosts.clear();
  }

  /** The batch is applied: views it removed leave the page, unless they
   * are inside a modal, screen or view that is animating out, which takes
   * them along (an app removes the content with its container, and the
   * content must still show while the container leaves). */
  finishRemovals() {
    const removals = this.removals;
    this.removals = [];
    for (const el of removals) {
      if (!el._removing) continue;
      el._removing = false;
      let up = el.parentNode;
      while (up && up !== this.root && !(up._leaving || up._popping || up._removedFrom || up._dying)) up = up.parentNode;
      if (up && up !== this.root) el._leftWith = up;
      else el.remove();
    }
  }

  view(id) {
    return this.views.get(id);
  }

  op_c([, id, kind]) {
    let el;
    if (kind === "canvas") {
      el = document.createElement("div");
      const canvas = document.createElement("canvas");
      canvas.className = "nsh-fill";
      el.append(canvas);
      el._canvas = canvas;
      el._slots = [];
    } else if (kind === "web") {
      el = document.createElement("div");
      const frame = document.createElement("iframe");
      frame.className = "nsh-fill";
      el.append(frame);
      el._frameEl = frame;
      frame.addEventListener("load", () => this.webLoaded(el));
    } else if (kind === "video") {
      el = document.createElement("div");
      const video = document.createElement("video");
      video.playsInline = true;
      video.className = "nsh-fill";
      el.append(video);
      el._video = video;
      this.wireVideo(el, video);
    } else {
      el = document.createElement("div");
    }
    el._id = id;
    el._kind = kind;
    el._events = new Set();
    el._animation = {};
    el._frame = null;
    el.className = kind === "scroll" ? "nsh-v nsh-scroll" : "nsh-v";
    if (kind === "image") {
      const img = document.createElement("img");
      img.draggable = false;
      img.className = "nsh-fill nsh-fit-cover";
      img.addEventListener("load", () => this.imageLoaded(el, img));
      img.addEventListener("error", () => this.imageFailed(el));
      el.append(img);
      el._img = img;
      el.classList.add("nsh-clip");
    }
    if (kind === "scroll") {
      el._spacer = document.createElement("div");
      el._spacer.className = "nsh-spacer";
      el.append(el._spacer);
      el._applied = 0;
      el.addEventListener("scroll", () => this.scrolled(el), { passive: true });
      el.addEventListener("scrollend", () => this.scrollEnded(el));
      // The user takes over a scroll animation of the core's.
      const takeOver = () => this.endScrollAnimation(el, false);
      for (const type of ["wheel", "pointerdown", "touchstart", "keydown"]) el.addEventListener(type, takeOver, { passive: true });
    }
    if (kind === "screen") el.classList.add("nsh-screen");
    if (kind === "modal") el.classList.add("nsh-modal");
    if (kind === "stack") el.classList.add("nsh-clip");
    if (this.layoutAnimation?.create) this.appearing.push(el);
    this.views.set(id, el);
  }

  op_i([, parentId, childId, beforeId]) {
    const parent = this.view(parentId);
    const child = this.view(childId);
    if (!parent || !child) return;
    if (child._kind === "modal") {
      child._host = parent;
      this.goneModals?.delete(child);
      this.present(child);
      return;
    }
    const before = beforeId == null ? null : this.view(beforeId);
    if (child._kind === "header") {
      child._headerParent = parent;
      return;
    }
    // Back before its removal finished animating.
    if (child._dying) this.revive(child);
    child._removedFrom = null;
    child._removing = false;
    child._leftWith = null;
    const host = parent._layer ?? parent;
    // Appended children stay under a border drawn over them.
    const last = host._borderOver && host._border?.parentNode === host ? host._border : null;
    this.placeChild(host, child, before && before.parentNode === host ? before : last);
    if (this.leftPlaying?.size) this.videosBack(child);
    this.showHosted(child);
    this.readingChanged(host);
    if (parent._kind === "stack") {
      this.changedStacks.add(parent);
      this.stackChanged(parent, child);
    }
  }

  /** `<Video>`s the browser paused as they left the document, back with
   * `el`: those the app has not paused since play on. */
  videosBack(el) {
    for (const v of this.leftPlaying) {
      if (!el.contains(v)) continue;
      this.leftPlaying.delete(v);
      if (v._paused === false && v._src && v._video.paused && v.isConnected) this.playVideo(v, v._video);
    }
  }

  /// Puts `child` before `ref` in `host`. A restack (`zIndex` changed)
  /// re-inserts a view already there; moving the node holding the focus
  /// would drop it (and fire blur), so its siblings move around it instead.
  placeChild(host, child, ref) {
    const active = document.activeElement;
    if (child.parentNode !== host || !active || active === document.body || !child.contains(active)) {
      host.insertBefore(child, ref);
      return;
    }
    if (child === ref || child.nextSibling === ref) return;
    const moved = [];
    let forward = false;
    for (let n = child.nextSibling; n; n = n.nextSibling) {
      if (n === ref) { forward = true; break; }
    }
    if (ref === null) forward = true;
    if (forward) {
      for (let n = child.nextSibling; n && n !== ref; n = n.nextSibling) moved.push(n);
      for (const n of moved) host.insertBefore(n, child);
    } else {
      for (let n = ref; n && n !== child; n = n.nextSibling) moved.push(n);
      const anchor = child.nextSibling;
      for (const n of moved) host.insertBefore(n, anchor);
    }
  }

  op_r([, id]) {
    const el = this.view(id);
    if (!el) return;
    this.hideHosted(el);
    if (el._kind === "modal") {
      this.goneModals?.delete(el);
      this.dismiss(el);
      return;
    }
    const parent = el.parentNode;
    const focused = el.contains(document.activeElement);
    this.detach(el, parent);
    if (parent?._kind === "stack") this.stackChanged(parent);
    this.screenGone(el, focused);
  }

  /** Modals presented from inside `el`, which leaves the tree, go with it:
   * they are the root's children, out of `el`'s subtree, and the browser's
   * graph deletes them only once their nodes are collected. */
  hideHosted(el) {
    for (const modal of [...this.root.children]) {
      const host = modal._host;
      if (modal._kind !== "modal" || modal._leaving || !host || (host !== el && !el.contains(host))) continue;
      (this.goneModals ??= new Set()).add(modal);
      this.dismiss(modal, true);
      this.hideHosted(modal);
    }
  }

  /** `el` is back in the tree: the modals that went with it come back. */
  showHosted(el) {
    if (!this.goneModals?.size) return;
    for (const modal of this.goneModals) {
      const host = modal._host;
      if ((host !== el && !el.contains(host)) || !this.root.contains(host)) continue;
      this.goneModals.delete(modal);
      this.present(modal);
      this.showHosted(modal);
    }
  }

  /** Takes `el` out of `parent`: a screen once its stack is reconciled
   * (it may animate out), a view animating its removal when it ends. */
  detach(el, parent) {
    if (el._dying || el._removedFrom) return;
    if (el._kind === "screen" && parent?._kind === "stack") {
      el._removedFrom = parent;
      this.changedStacks.add(parent);
    } else if (this.layoutAnimation?.delete && parent && !this.navigated(el, parent)) {
      el._dying = true;
      el.style.pointerEvents = "none";
      this.disappearing.push(el);
    } else {
      el._removing = true;
      this.removals.push(el);
    }
  }

  op_d([, id]) {
    const el = this.view(id);
    if (!el) return;
    this.views.delete(id);
    this.mouseTracked.delete(id);
    this.wheelTracked.delete(id);
    if (el._shader) this.dropShader(el);
    if (el._video) {
      this.leftPlaying?.delete(el);
      // A removed media element keeps playing until it is collected.
      clearInterval(el._progressTimer);
      el._video.pause();
      el._video.removeAttribute("src");
      el._video.load();
    }
    if (el._kind === "modal") {
      this.goneModals?.delete(el);
      this.dismiss(el);
      return;
    }
    const parent = el.parentNode;
    const focused = el.contains(document.activeElement);
    this.detach(el, parent);
    if (parent?._kind === "stack") this.stackChanged(parent);
    this.screenGone(el, focused);
  }

  /** A screen left its stack: the focus goes back to what had it when the
   * screen was pushed, unless it moved elsewhere meanwhile. */
  screenGone(el, focused) {
    const restore = el._restoreFocus;
    el._restoreFocus = null;
    const focus = document.activeElement;
    if (restore?.isConnected && (focused || !focus || focus === document.body)) restore.focus({ preventScroll: true });
  }

  op_f([, id, x, y, w, h]) {
    const el = this.view(id);
    // Where a modal sits, and its size, are the platform's (a sheet is a
    // card inside the root): the core lays it out at the size reported.
    if (!el || el._kind === "modal") return;
    // A view that had a frame moves from where it shows (a running
    // animation's frame); a new one's first frame does not animate, nor
    // does a sticky cell's (the browser keeps it in its track).
    const update = this.layoutAnimation?.update;
    const from = update && el._frame && !el._track && !this.navigated(el, el.parentNode) ? this.shownFrame(el) : null;
    el._frameAnimation?.cancel();
    el._frameAnimation = null;
    const resized = !el._frame || el._frame[2] !== w || el._frame[3] !== h;
    // A stack laid out at no size (`display: none`: a tab not selected) or
    // at one again changes whether it shows (`stackShown`).
    const emptied = el._kind === "stack" && el._frame && !(el._frame[2] > 0 && el._frame[3] > 0) !== !(w > 0 && h > 0);
    const seen = this.seenByKeys(el);
    el._frame = [x, y, w, h];
    if (resized && el._kind === "scroll") this.scrollFits(el);
    // No size: nothing of its own shows (`.nsh-empty`).
    el.classList.toggle("nsh-empty", !(w > 0 && h > 0));
    if (emptied) this.syncHistorySoon();
    if (seen !== this.seenByKeys(el)) {
      if (el._pressable || el._props?.focusable || el.matches?.(NATIVE_STOPS)) this.updateFocusable(el);
      if (el._field) this.fieldStop(el);
    }
    this.placeFrame(el);
    this.readingChanged(el.parentNode);
    if (resized && el._corners) this.placeCorners(el);
    if (from && from.some((v, i) => v !== el._frame[i])) {
      const box = (f) => ({ left: `${f[0]}px`, top: `${f[1]}px`, width: `${f[2]}px`, height: `${f[3]}px` });
      const a = this.animateLayout(el, [box(from), box(el._frame)], update);
      a.onfinish = () => { if (el._frameAnimation === a) el._frameAnimation = null; };
      el._frameAnimation = a;
    }
    // A canvas moved keeps its pixels (rows of a table move every scroll).
    if (el._kind === "canvas" && resized) this.drawSoon(el);
    if (el._shader) this.shaderDirty(el);
    if (el._kind === "stack") for (const screen of el.children) if (screen._kind === "screen") this.reportRoot(screen, w, h, this.screenInsets(screen));
  }

  placeFrame(el) {
    if (el === this.root && this.frameSession) return;
    const f = el._frame;
    if (!f) return;
    if (el._track) {
      this.placeTrack(el);
      return;
    }
    const s = el.style;
    s.left = `${f[0]}px`;
    s.top = `${f[1]}px`;
    s.width = `${f[2]}px`;
    s.height = `${f[3]}px`;
  }

  /** A class from the engine: a view's own rules are the player's. */
  styleClass(name) {
    return name && name.charCodeAt(0) === 105 ? this.classPrefix + name : name;
  }

  op_css([, name, text]) {
    const own = name.charCodeAt(0) === 105;
    defineClass(own ? this.classPrefix + name : name, text, own);
  }

  /** Visual style: its class replaces the previous one; the frame and
   * animated properties are inline. */
  op_s([, id, css, border, tint, ...corners]) {
    const el = this.view(id);
    if (!el) return;
    swapClass(el, "_class", this.styleClass(css));
    if (CORNER_SHAPE) {
      // Marks the views a clipping `corner-shape` ancestor must not hide (`.nsh-curve-clip`).
      const backdrop = CLASSES.rules.get(el._class)?.style.backdropFilter;
      el.classList.toggle("nsh-backdrop", !!backdrop && backdrop !== "none");
    }
    if (border) {
      if (!el._border) el._border = document.createElement("div");
      el._border.className = `nsh-border ${this.styleClass(border)}`;
      el._border._cornerClass = null;
      if (el._animation["border-color"]) el._border.style.borderColor = el._animation["border-color"];
      // As on iOS and macOS: a view that does not clip has its border under
      // its child views (a label on an outlined field covers it), over its
      // own fills (a shader, text runs); a clipping one (a rounded card with
      // a full-bleed image) has it over its children, as a layer border.
      const overflow = CLASSES.rules.get(el._class)?.style.overflow;
      el._borderOver = !!(overflow && overflow !== "visible") || el.classList.contains("nsh-scroll") || el.classList.contains("nsh-clip");
      let next = null;
      if (!el._borderOver) {
        next = el.firstChild;
        while (next && (next === el._border || next._kind === undefined)) next = next.nextSibling;
      }
      if (el._border.nextSibling !== next || el._border.parentNode !== el) el.insertBefore(el._border, next);
    } else if (el._border) {
      el._border.remove();
      el._border = null;
    }
    el._corners = corners.length ? corners : null;
    this.placeCorners(el);
    if (el._kind === "image") {
      el._tint = tint;
      this.applyTint(el);
    }
  }

  /**
   * `borderCurve: "continuous"` as CSS `corner-shape`, which shapes the view's
   * border, shadows, clip and backdrop too. Corners reach as far along the
   * edges as iOS's, and pass where circular corners of the radius do on the
   * diagonal, so a radius looks as round as on the native backends. Without
   * room to reach that far they stay circular, so a pill stays a pill, as
   * `nsh-platform-macos`'s; so do browsers without `corner-shape`.
   *
   * Chromium (verified in 156) shows no backdrop filter, or one without its
   * mask, inside a view that clips with `corner-shape` corners. A clipping
   * view (`nsh-curve-clip`) falls back to circular corners of the radius
   * (`--nsh-round`) while a backdrop-filtered view (`nsh-backdrop`, `op_s`)
   * is inside it.
   */
  placeCorners(el) {
    const r = el._corners;
    const f = el._frame;
    const fits = CORNER_SHAPE && r && f && Math.max(...r) * CONTINUOUS_REACH <= Math.min(f[2], f[3]) / 2;
    const name = fits
      ? cssClass(
          `border-radius:${r.map((v) => `${v * CONTINUOUS_REACH}px`).join(" ")};corner-shape:superellipse(${CONTINUOUS_SUPERELLIPSE});--nsh-round:${r.map((v) => `${v}px`).join(" ")};`,
          3,
        )
      : null;
    swapClass(el, "_cornerClass", name);
    if (CORNER_SHAPE) {
      const overflow = fits ? CLASSES.rules.get(el._class)?.style.overflow : "";
      const clips = fits && ((overflow && overflow !== "visible") || el.classList.contains("nsh-scroll") || el.classList.contains("nsh-clip"));
      el.classList.toggle("nsh-curve-clip", !!clips);
    }
    if (el._border) swapClass(el._border, "_cornerClass", name);
  }

  op_a([, id, prop, value]) {
    const el = this.view(id);
    if (!el) return;
    // A view that left the page keeps its bindings until its node is
    // collected (`op_d`), which may be long after: a view mounted and
    // removed again and again (a looping pulse inside a condition) would
    // have every batch write many views no one sees. One that was on the
    // page and is off it now is skipped; it is written again with the
    // batch that inserts it again (every batch writes every bound value,
    // after its inserts). One never on the page yet is written, so it
    // shows its values once it is; one animating out is still on it.
    if (el.isConnected) el._onPage = true;
    else if (el._onPage) return;
    if (prop.startsWith("canvas:") && el._shader) {
      this.shaderSlot(el, Number(prop.slice(7)), value);
      return;
    }
    if (prop.startsWith("canvas:")) {
      const slot = Number(prop.slice(7));
      const v = isNaN(Number(value)) ? value : Number(value);
      // The animator sends every bound value with each batch: a value
      // that stayed draws nothing again.
      if (el._slots[slot] === v) return;
      el._slots[slot] = v;
      this.drawSoon(el);
      return;
    }
    if (prop === "sticky-offset") {
      // A sticky cell sticks this much further in (an animated offset).
      const offset = Number(value);
      if (el._stickyOffset === offset) return;
      el._stickyOffset = offset;
      if (el._track) this.placeTrack(el);
      return;
    }
    // The animator sends every bound value with each batch. Compared with
    // what the view shows, not what was last sent: navigation and modals'
    // motions write a view's transform and opacity too.
    const shown = prop === "border-color" || prop === "color" ? el._animation[prop] : el.style.getPropertyValue(prop);
    if (shown === value) return;
    el._animation[prop] = value;
    if (prop === "border-color") {
      // Borders are drawn by an overlay.
      if (el._border) el._border.style.borderColor = value;
      return;
    }
    if (prop === "color") {
      // Each run has its own color.
      for (const span of el.querySelectorAll(":scope > .nsh-run")) span.style.color = value;
      return;
    }
    el.style.setProperty(prop, value);
  }

  op_t([, id, cx, cy, , , runs, styles, selectable, selection, color, backgrounds, links, copies]) {
    const el = this.view(id);
    if (!el) return;
    // What its attachments copy as (`copyText`): `[offset, text, run,
    // before]`, by where the copy puts them among the runs.
    el._copyTexts = copies?.length ? copies : null;
    setTextColor(el, color ?? null);
    if (!this.updateRuns(el, cx, cy, runs, styles, backgrounds, links)) this.replaceRuns(el, cx, cy, runs, styles, backgrounds, links);
    el.classList.toggle("nsh-selectable", !!selectable);
    el.classList.toggle("nsh-autoselect", selectable == null);
    el.classList.toggle("nsh-noselect", selectable === false);
    // Its `--nsh-selection`.
    swapClass(el, "_selection", this.styleClass(selection));
    el._textLabel = runs.map((r) => r[2] + (r[6] ?? "")).join("").trimEnd();
    if (el._props?.label == null) {
      if (el._field) this.fieldAria(el, el._field);
      else el.setAttribute("aria-label", el._textLabel);
    }
  }

  /**
   * A text of plain runs that had plain runs (a cell's new value, a
   * counter, an answer streamed in): its spans take the new texts and
   * places in place, and only the runs it gained or lost are made or
   * removed, so a text that changes often remakes no nodes for the lines
   * that stayed. False when the runs cannot be updated so (backgrounds,
   * links, runs of parts).
   */
  updateRuns(el, cx, cy, runs, styles, backgrounds, links) {
    if (backgrounds?.length || links?.length || !runs.length) return false;
    const spans = [];
    for (const child of el.children) {
      if (child.classList.contains("nsh-run-bg")) return false;
      if (child.classList.contains("nsh-run")) spans.push(child);
    }
    if (!spans.length) return false;
    for (let i = 0; i < runs.length; i++) {
      const [, , text, , , parts] = runs[i];
      if (parts || !text) return false;
      if (i >= spans.length) continue;
      const node = spans[i].firstChild;
      // Only a span holding one text node, as `fillRun` leaves plain text.
      if (!node || node.nodeType !== 3 || node.nextSibling) return false;
    }
    // The runs it lost go; those it gained follow the last span kept (past
    // its line's break, which `lineBreaks` keeps).
    for (const span of spans.splice(runs.length)) span.remove();
    let before = spans[spans.length - 1]?.nextSibling;
    if (before?.nodeType === 3) before = before.nextSibling;
    while (spans.length < runs.length) {
      const span = document.createElement("span");
      span.append(document.createTextNode(""));
      if (el._animation.color) span.style.color = el._animation.color;
      el.insertBefore(span, before ?? null);
      spans.push(span);
    }
    runs.forEach(([x, y, text, style, start, , after], i) => {
      const span = spans[i];
      const name = this.styleClass(styles[style]);
      const className = name ? `nsh-run ${name}` : "nsh-run";
      if (span.className !== className) span.className = className;
      const left = `${cx + x}px`, top = `${cy + y}px`;
      if (span.style.left !== left) span.style.left = left;
      if (span.style.top !== top) span.style.top = top;
      if (span.firstChild.data !== text) span.firstChild.data = text;
      span._start = start;
      span._run = i;
      if (after) span._after = after;
      else delete span._after;
    });
    this.lineBreaks(el);
    return true;
  }

  /**
   * The characters a line broke at (`after`: the space a soft break ate,
   * a hard break's newline) as text between the runs' spans, so the
   * text's `textContent` reads as it was written ("it now brings", never
   * "it nowbrings"): what search engines and the page's markup see. They
   * are whitespace beside absolutely placed spans, which collapses: nothing
   * shows of them.
   */
  lineBreaks(el) {
    // A break already in its place stays: a text that changes often (an
    // answer streamed in) moves no nodes for the lines it did not change.
    for (const node of [...el.childNodes]) {
      if (node.nodeType !== 3) continue;
      const span = node.previousSibling;
      if (!span?.classList?.contains("nsh-run") || span._after !== node.data) node.remove();
    }
    for (const span of el.querySelectorAll(":scope > .nsh-run")) {
      if (span._after && span.nextSibling?.nodeType !== 3) span.after(span._after);
    }
  }

  /** The runs of a text made again: its spans and their backgrounds. */
  replaceRuns(el, cx, cy, runs, styles, backgrounds, links) {
    const frag = document.createDocumentFragment();
    // Span backgrounds, behind the runs: one box per span and line.
    for (const [x, y, w, h, r, color] of backgrounds ?? []) {
      const box = document.createElement("div");
      box.className = "nsh-run-bg";
      box.style.cssText = `left:${cx + x}px;top:${cy + y}px;width:${w}px;height:${h}px;` +
        `border-radius:${r}px;background:${color}`;
      frag.append(box);
    }
    // Nested texts that take presses: `[node, events]`, which runs name.
    const spans = (links ?? []).map(([node, events]) => ({ node, events: new Set(events) }));
    runs.forEach(([x, y, text, style, start, parts, after], i) => {
      const span = document.createElement("span");
      const name = this.styleClass(styles[style]);
      span.className = name ? `nsh-run ${name}` : "nsh-run";
      span.style.cssText = `left:${cx + x}px;top:${cy + y}px`;
      fillRun(span, text, parts, spans);
      // Where its characters are in the text (UTF-16, as JS strings).
      span._start = start;
      // Which run it is (attachments' copy texts name it).
      span._run = i;
      // The line's break, for copying (`copy`).
      if (after) span._after = after;
      if (el._animation.color) span.style.color = el._animation.color;
      frag.append(span);
    });
    for (const span of [...el.querySelectorAll(":scope > .nsh-run, :scope > .nsh-run-bg")]) span.remove();
    el.insertBefore(frag, el.firstChild);
    this.lineBreaks(el);
    if (!el._linkHoverListeners && spans.some((l) => l.events.has("onMouseEnter") || l.events.has("onMouseLeave"))) {
      this.installLinkHover(el);
    }
  }

  /**
   * The mouse over the links of text `el` (the `_link` of the run spans
   * under it): a link listening hears `onMouseEnter` when the mouse comes
   * over its characters (on any of its lines) and `onMouseLeave` when it
   * leaves them, as the other desktops report a link's hover (the core
   * shows a link's hint, its URL, by them). Installed once per text; the
   * listeners read the spans the runs have now.
   */
  installLinkHover(el) {
    el._linkHoverListeners = true;
    const follow = (e) => {
      if (e.pointerType !== "mouse") return;
      const link = e.type === "pointerleave" ? null : (e.target?._link ?? null);
      const old = el._linkHover;
      if ((old?.node ?? null) === (link?.node ?? null)) return;
      el._linkHover = link;
      if (old?.events.has("onMouseLeave")) this.event(old.node, "onMouseLeave", this.mouseEvent(el, e, true));
      if (link?.events.has("onMouseEnter")) this.event(link.node, "onMouseEnter", this.mouseEvent(el, e, true));
    };
    el.addEventListener("pointerover", follow);
    el.addEventListener("pointermove", follow);
    el.addEventListener("pointerleave", follow);
  }


  op_e([, id, events]) {
    const el = this.view(id);
    if (!el) return;
    el._events = new Set(events);
    if (el._events.has("onMouseMove")) this.mouseTracked.add(id);
    else this.mouseTracked.delete(id);
    if (el._events.has("onWheel")) this.wheelTracked.add(id);
    else this.wheelTracked.delete(id);
    const pressable = PRESS_EVENTS.some((e) => el._events.has(e));
    el._pressable = pressable;
    this.updateFocusable(el);
    this.updateTouchAction(el);
    if (el._kind === "scroll" && el._events.has("onRefresh")) this.installPull(el);
    if (!el._mouseEvents && MOUSE_EVENTS.some((e) => el._events.has(e))) this.installMouse(el);
  }

  /**
   * `onMouseEnter` / `onMouseLeave` of `el`, from the mouse's pointer
   * events (pointerenter and pointerleave reach the views around the one
   * under the mouse too, as with `:hover`), with or without a button down;
   * leaving, from where the mouse went. Whether the mouse is over `el`
   * (`_hoverIn`) also decides who hears a modifier key change
   * (`modifiersChanged`). Moves are `mouseMoved`'s.
   */
  installMouse(el) {
    el._mouseEvents = true;
    el.addEventListener("pointerenter", (e) => {
      if (e.pointerType !== "mouse") return;
      el._hoverIn = true;
      if (el._events.has("onMouseEnter")) this.event(el._id, "onMouseEnter", this.mouseEvent(el, e, true));
    });
    el.addEventListener("pointerleave", (e) => {
      if (!el._hoverIn) return;
      el._hoverIn = false;
      if (el._events.has("onMouseLeave")) this.event(el._id, "onMouseLeave", this.mouseEvent(el, e, true));
    });
  }

  /**
   * The `MouseEvent` payload of `el` for the mouse at `e`'s `clientX` /
   * `clientY`, with `e`'s modifiers and held button: the position in `el`
   * with its transforms undone, null when they leave no area, unless
   * `always`, which takes its box's offset then.
   */
  mouseEvent(el, e, always = false) {
    let position = this.mousePoint(el, e);
    if (!position) {
      if (!always) return null;
      const r = el.getBoundingClientRect();
      position = [e.clientX - r.left, e.clientY - r.top];
    }
    const [pageX, pageY] = this.point(e);
    const held = MOUSE_BUTTONS.find(([bit]) => e.buttons & bit);
    return {
      position: { x: position[0], y: position[1] },
      pagePosition: { x: pageX, y: pageY },
      modifiers: { control: !!e.ctrlKey, alt: !!e.altKey, shift: !!e.shiftKey, platform: !!e.metaKey },
      pressedButton: held ? held[1] : null,
      pointerType: e.pointerType === "pen" ? "pen" : "mouse",
      pressure: e.pressure ?? (held ? 0.5 : 0),
      tiltX: e.tiltX || 0,
      tiltY: e.tiltY || 0,
    };
  }

  op_ts([, id, states]) {
    const el = this.view(id);
    if (!el) return;
    el._tracked = states;
    // The focus is reported whatever is tracked (the core works out
    // `focus-within` from it): it stays; the rest is forgotten.
    el._states = (el._states || 0) & FOCUSED;
    if (states & HOVERED && !el._hoverListeners) this.installHover(el);
  }

  /** `hover:` of view `el` (`op_ts`), from the mouse's pointer events. */
  installHover(el) {
    el._hoverListeners = true;
    el.addEventListener("pointerenter", (e) => e.pointerType === "mouse" && this.setState(el, HOVERED, true));
    el.addEventListener("pointerleave", () => this.setState(el, HOVERED, false));
  }

  /** Tells the core the input modality (0 the keyboard, 1 a pointer);
   * the engine's control passes on only a change. */
  inputWith(modality) {
    // Optional: test stand-ins for the engine may lack it.
    if (this.wasm) this.call((w) => w.nsh_input_modality?.(modality));
  }

  setState(el, bit, on) {
    // The focus is reported whatever is tracked (`reported_states`).
    if (!(((el._tracked || 0) | FOCUSED) & bit)) return;
    const states = el._states || 0;
    const next = on ? states | bit : states & ~bit;
    if (next === states) return;
    el._states = next;
    this.call((w) => w.nsh_states(el._id, next));
  }

  op_vp([, id, props]) {
    let el = this.view(id);
    if (!el) return;
    el = this.retag(el, elementTag(props));
    if (props.href != null) el.setAttribute("href", this.siteBase ? this.linkHref(props.href) : props.href);
    else el.removeAttribute("href");
    el._props = props;
    // A list in its parent's viewport: its cells are read in screen order.
    if (el._screenOrder !== props.screenOrder) {
      el._screenOrder = props.screenOrder;
      this.readingChanged(el);
    }
    if (props.testID) el.dataset.testid = props.testID;
    else delete el.dataset.testid;
    const pe = props.pointerEvents;
    el.classList.toggle("nsh-inert", pe === "none");
    el.classList.toggle("nsh-box-none", pe === "box-none");
    el.classList.toggle("nsh-area", !!props.selectableView);
    this.updateFocusable(el);
    this.updateTouchAction(el);
  }

  /**
   * The view drawn as the HTML element `elementTag` gives it (`h1`, `a`,
   * `p`, `nav`, ...), else a `div`: the element is replaced by one of that
   * tag carrying its attributes, children, fields and listeners, so search
   * engines and the page's markup see the document's structure while the
   * layout, styles and events stay the view's. Views whose element holds a
   * control of its own (images, scroll views, canvases, ...) keep theirs.
   */
  retag(el, tag) {
    if (el.localName === tag || (el._kind !== "view" && el._kind !== "text")) return el;
    const next = document.createElement(tag);
    // Inline styles (a frame's) through the CSSOM: a strict `style-src`
    // refuses a `style` attribute set as text.
    for (const { name, value } of el.attributes) if (name !== "style") next.setAttribute(name, value);
    if (el.style.cssText) next.style.cssText = el.style.cssText;
    for (const key of Object.keys(el)) next[key] = el[key];
    next.append(...el.childNodes);
    el.replaceWith(next);
    this.views.set(el._id, next);
    // Listeners stay with the element they were added to, and a new view's
    // tracked states and events come before the props that name its tag
    // (a `Link`'s `href`): the flags copied above say which to add again.
    if (el._mouseEvents) this.installMouse(next);
    if (el._hoverListeners) this.installHover(next);
    if (el._focusListeners) this.installFocus(next);
    if (el._linkHoverListeners) this.installLinkHover(next);
    if (tag === "a") next.draggable = false;
    return next;
  }

  op_al([, id, label]) {
    const el = this.view(id);
    if (!el) return;
    (el._props ??= {}).label = label;
    this.updateAria(el);
  }

  /** ARIA attributes from the accessibility props (`op_vp`). */
  updateAria(el) {
    const p = el._props ?? {};
    const set = (name, value) => setAriaAttribute(el, name, value);
    const role = ARIA_ROLES[p.role] ?? (p.role && p.role !== "none" ? p.role : el._pressable ? "button" : null);
    // A combo box that is an input is its field, which keeps the focus
    // (`fieldAria`).
    set("role", el._field && p.role === "combobox" ? null : role);
    if (!el._field) {
      set("aria-label", p.label ?? el._textLabel);
      set("aria-description", p.hint);
    }
    set("aria-disabled", p.disabled && "true");
    set("aria-selected", p.selected && "true");
    set("aria-checked", p.checked);
    set("aria-busy", p.busy && "true");
    // `false` too: a collapsed combo box or disclosure says so.
    set("aria-expanded", p.expanded == null ? null : String(p.expanded));
    set("aria-haspopup", p.hasPopup && "true");
    set("aria-pressed", p.pressed);
    set("aria-current", p.current);
    set("aria-invalid", p.invalid && "true");
    if (el._field) this.fieldAria(el, el._field);
    set("aria-level", p.level);
    const [min, max, now, text] = p.value ?? [];
    set("aria-valuemin", min);
    set("aria-valuemax", max);
    set("aria-valuenow", now);
    set("aria-valuetext", text);
    set("aria-live", p.live);
    set("aria-hidden", p.hidden && "true");
    set("aria-orientation", p.orientation);
    if (p.activeDescendant != null || p.controls != null || p.describedBy != null || el._related) {
      // Linked once the batch is applied (`linkRelations`).
      el._related = p.activeDescendant != null || p.controls != null || p.describedBy != null;
      (this.relating ??= new Set()).add(el);
    }
  }

  /** The stops of the keyboard focus (Tab), as `ViewProps::focus_stop`
   * decides: pressables (Enter and Space press them) unless `focusable`
   * false, and any `focusable` view, pressable or not (its keys reach it
   * through the app's keymap); never disabled ones, those hidden from
   * assistive technologies or those with no area (`seenByKeys`). */
  updateFocusable(el) {
    const p = el._props;
    const seen = this.seenByKeys(el);
    const focusable = (p?.focusable ?? !!el._pressable) && !p?.disabled && !p?.hidden && seen;
    if (focusable) el.tabIndex = 0;
    // Programmatic focus only for what screen-reader focus moved to; an
    // element Tab reaches without a `tabindex` (a link, `web={{ element }}`)
    // keeps none while it has no area.
    else if (el._a11yFocus || (!seen && el.matches?.(NATIVE_STOPS))) el.tabIndex = -1;
    else if (el.hasAttribute("tabindex")) el.removeAttribute("tabindex");
    // No longer a stop with the focus on it: it leaves, as on macOS (browsers
    // move it without a `blur`, which would leave `focus:` on).
    if (!focusable && !el._a11yFocus && document.activeElement === el) el.blur();
    if (focusable && !el._focusListeners) this.installFocus(el);
    this.updateAria(el);
  }

  /** `focus:` classes, `onFocus` and `onBlur` of Tab stop `el`
   * (`updateFocusable`): they follow the keyboard focus (the browser draws
   * a ring only then), not the focus a click would give. */
  installFocus(el) {
    el._focusListeners = true;
    el.addEventListener("focus", () => {
      if (!el._focusCall && !el.matches(":focus-visible")) return;
      this.keyFocus(el);
    });
    el.addEventListener("blur", () => {
      this.setState(el, FOCUSED, false);
      if (!el._keyFocus) return;
      el._keyFocus = false;
      this.event(el._id, "onBlur");
    });
  }

  /** Whether the keyboard reaches view `el` (a Tab stop, an input's
   * field): it has an area. The core lays out each view of a
   * `display: none` subtree at no size, which hides nothing in a browser,
   * so Tab would stop at what it holds; macOS keeps the same rule
   * (`NshView::seen_by_keys`), and browsers already pass by
   * `visibility: hidden`. A view before its first frame counts: its props
   * come first, and the frame then decides. */
  seenByKeys(el) {
    const f = el._frame;
    return !f || (f[2] > 0 && f[3] > 0);
  }

  /** Input `el`'s field is a Tab stop while its view and its content box
   * have an area (`seenByKeys`); one that hides with the focus in it gives
   * the focus up, as a hidden Tab stop does. */
  fieldStop(el) {
    const field = el._field;
    if (!field) return;
    const c = el._content;
    const seen = this.seenByKeys(el) && (!c || (c[2] > 0 && c[3] > 0));
    if (seen) field.removeAttribute("tabindex");
    else field.tabIndex = -1;
    if (!seen && document.activeElement === field) field.blur();
  }

  /** The name, description and states of input view `el` go on its `field`:
   * the field is the element screen readers read as the input. */
  fieldAria(el, field) {
    const p = el._props ?? {};
    const set = (name, value) => setAriaAttribute(field, name, value);
    set("aria-label", (p.label ?? el._textLabel) || null);
    set("aria-description", p.hint || null);
    // Props may arrive before the field exists; its wrapper then held the name.
    setAriaAttribute(el, "aria-label", null);
    setAriaAttribute(el, "aria-description", null);
    set("aria-invalid", p.invalid && "true");
    // A combo box's field is the combo box: the focus stays in it while
    // its list is open, and its active descendant is the highlighted row.
    const combobox = p.role === "combobox";
    set("role", combobox && "combobox");
    set("aria-expanded", combobox && p.expanded != null ? String(p.expanded) : null);
    set("aria-haspopup", combobox && p.hasPopup && "listbox");
    // A field made after the relations takes them (`linkRelations`).
    if (el._related) (this.relating ??= new Set()).add(el);
  }

  /** The keyboard focus reached pressable `el`: `focus:` and `onFocus`. */
  keyFocus(el) {
    el._keyFocus = true;
    this.setState(el, FOCUSED, true);
    this.event(el._id, "onFocus");
  }

  /** `focus()` on a view that is a stop of Tab: it takes the keyboard
   * focus as Tab gives it, with the ring (`focusVisible`, where browsers
   * take it) and `focus:` whatever the browser's heuristics decide after a
   * click; one a click focused becomes keyboard focused. */
  focusPressable(el) {
    if (el.tabIndex !== 0) return;
    if (document.activeElement === el) {
      if (!el._keyFocus) this.keyFocus(el);
      return;
    }
    el._focusCall = true;
    try {
      el.focus({ focusVisible: true, preventScroll: true });
    } finally {
      el._focusCall = false;
    }
  }

  /** What touches on `el` leave to the browser: nothing on views with
   * native pans, pinches or rotations; a `panActivation` gate along one
   * axis leaves scrolling along the other, and one with a way the drags
   * the other way too, where the browser offers it. Views that take
   * presses or touches are marked: text in them is not selected by
   * default. */
  updateTouchAction(el) {
    const pan = el._gestures?.pan || el._events.has("onPanStart") || el._events.has("onPanEnd");
    const pinch = el._gestures?.pinch || el._gestures?.rotation;
    el.classList.toggle("nsh-press", !!(el._pressable || pan || pinch || el._events.has("onTouch")));
    const gate = el._props?.panActivation;
    const way = gate ? this.panWay(gate) : undefined;
    const horizontal = gate && (way ? way === "left" || way === "right" : gate[0] != null && gate[1] == null);
    const vertical = gate && (way ? way === "up" || way === "down" : gate[1] != null && gate[0] == null);
    el.classList.toggle("nsh-pan", !!(pinch || (pan && !horizontal && !vertical)));
    el.classList.toggle("nsh-pan-x", !pinch && !way && !!horizontal);
    el.classList.toggle("nsh-pan-y", !pinch && !way && !!vertical);
    for (const w of ["left", "right", "up", "down"]) el.classList.toggle(`nsh-pan-${w}`, !pinch && way === w);
  }

  // Layout animations (`LayoutAnimation`): frames move, new views appear
  // and removed ones disappear with Web Animations, which run over the
  // views' own (inline and class) styles without replacing them, as the
  // Linux backend does (`transition.rs`). Not for navigation's views, nor
  // with reduced motion.

  op_la([, create, update, del]) {
    this.layoutAnimation = this.reduceMotion() ? null : { create, update, delete: del };
  }

  /** Views whose frames, appearing and disappearing belong to navigation. */
  navigated(el, parent) {
    return NAVIGATED.has(el._kind) || parent?._kind === "stack";
  }

  /** The frame `el` shows: where a running layout animation has it. */
  shownFrame(el) {
    if (!el._frameAnimation) return el._frame;
    const cs = getComputedStyle(el);
    return [cs.left, cs.top, cs.width, cs.height].map((v) => parseFloat(v) || 0);
  }

  /** Runs `keyframes` on `el` with layout transition `t`. */
  animateLayout(el, keyframes, t, fill = "backwards") {
    const options = { duration: t.duration, delay: t.delay, easing: t.easing, fill };
    try {
      return el.animate(keyframes, options);
    } catch {
      // A browser without `linear()` easings (a spring).
      return el.animate(keyframes, { ...options, easing: "ease-out" });
    }
  }

  /** The batch is applied: views it created appear, those it removed
   * disappear. */
  endLayoutAnimation() {
    const t = this.layoutAnimation;
    this.layoutAnimation = null;
    const appearing = this.appearing;
    const disappearing = this.disappearing;
    if (appearing.length) this.appearing = [];
    if (disappearing.length) this.disappearing = [];
    if (t?.create) {
      for (const el of appearing) {
        if (el.parentNode && !el._dying && !this.navigated(el, el.parentNode)) this.appear(el, t.create);
      }
    }
    for (const el of disappearing) {
      // A view inside one that disappears goes with it.
      let up = el.parentNode;
      while (up && up !== this.root && !up._dying) up = up.parentNode;
      if (up?._dying) {
        el._dying = false;
        el._leftWith = up;
        continue;
      }
      this.disappear(el, t.delete);
    }
  }

  appear(el, t) {
    this.animateLayout(el, t.property === "scale"
      // Not quite zero: a singular matrix cannot be inverted for picking.
      ? { transform: ["scale(0.01)", "scale(1)"], composite: "add" }
      // To the view's own opacity: multiplied by the progress.
      : [{ opacity: 0, offset: 0 }], t);
  }

  disappear(el, t) {
    const opacity = getComputedStyle(el).opacity;
    const a = this.animateLayout(el, t.property === "scale"
      ? { transform: ["scale(1)", "scale(0.01)"], composite: "add" }
      : [{ opacity }, { opacity: 0 }], t, "both");
    el._dying = a;
    a.onfinish = () => {
      if (el._dying !== a) return;
      el._dying = false;
      a.cancel();
      el.style.pointerEvents = "";
      el.remove();
      this.dropLeftWith(el);
    };
  }

  /** `el` is inserted again before its removal finished animating. */
  revive(el) {
    if (el._dying instanceof Animation) el._dying.cancel();
    el._dying = false;
    el.style.pointerEvents = "";
    this.dropLeftWith(el);
  }

  /** Views removed inside `el` while it disappeared leave it now. */
  dropLeftWith(el) {
    for (const child of el.querySelectorAll(".nsh-v")) {
      if (child._leftWith !== el) continue;
      child._leftWith = null;
      child.style.pointerEvents = "";
      child.remove();
    }
  }

  op_dir([, rtl]) {
    this.root.dir = rtl ? "rtl" : "ltr";
  }

  // The app's appearance (`setColorScheme`): 0 the system's, 1 light, 2 dark.
  op_appearance([, appearance]) {
    this.appearance = appearance;
    this.root.classList.toggle("nsh-scheme-light", appearance === 1);
    this.root.classList.toggle("nsh-scheme-dark", appearance === 2);
    this.updateRootClasses();
  }

  /** Dark appearance as shown: the app's, else the system's. */
  get shownDark() {
    return this.appearance ? this.appearance === 2 : this.dark;
  }

  // Images

  /**
   * `src`, `objectFit`, `placeholder` (shown until the image loads,
   * then faded out over `fadeDuration`), `blurRadius` (a CSS blur) and
   * `objectPosition` (CSS's, empty for the center).
   * Any URL the browser loads works: `asset:/` and http(s); `data:` URIs and
   * `blob:` URLs arrive as bytes (`image_bytes`) and show as browser blob URLs.
   */
  op_img([, id, uri, mode, placeholder, blur, fade, position, color]) {
    const el = this.view(id);
    if (!el?._img) return;
    const img = el._img;
    el._fit = mode;
    el._position = position || "";
    // The image's and the placeholder's classes (`nsh-hidden` is their state).
    el._imgClass = `nsh-fill nsh-fit-${mode}${blur > 0 ? ` ${cssClass(`filter:blur(${blur}px);`)}` : ""}${
      position ? ` ${cssClass(`object-position:${position};`)}` : ""
    }`;
    img.className = el._imgClass + (img.classList.contains("nsh-hidden") ? " nsh-hidden" : "");
    el._fade = fade;
    const ph = placeholder ? this.asset(placeholder) : "";
    if (ph && !el._ph) {
      el._ph = document.createElement("img");
      el._ph.draggable = false;
      el.insertBefore(el._ph, img);
    }
    if (el._ph) {
      el._ph.className = el._imgClass + (el._ph.classList.contains("nsh-hidden") ? " nsh-hidden" : "");
      if (ph) {
        if (el._ph.getAttribute("src") !== ph) this.setImageSource(el._ph, placeholder, ph);
      } else {
        el._ph.remove();
        el._ph = null;
      }
    }
    let src = this.asset(uri ?? "");
    // An `svg()`: its `currentColor` is `color`, its text color, written
    // into a copy of it (an SVG an `<img>` draws sees no page CSS), shown
    // once that copy is made.
    if (color && src) {
      const key = `${src}\n${color}`;
      if (el._srcKey === key) return;
      el._srcKey = key;
      const colored = this.svgInColor(src, color);
      if (typeof colored !== "string") {
        colored.then(() => {
          if (el._srcKey !== key || !el._img) return;
          el._srcKey = null;
          this.op_img([, id, uri, mode, placeholder, blur, fade, position, color]);
        });
        if (el._src) return;
        src = "";
      } else {
        src = colored;
      }
    } else {
      el._srcKey = null;
    }
    if (el._src === src) return;
    el._src = src;
    el._failed = false;
    if (el._ph) el._ph.classList.remove("nsh-hidden");
    if (!src) {
      img.removeAttribute("src");
      return;
    }
    // After the batch: its events may come after its props.
    queueMicrotask(() => el._events.has("onLoadStart") && this.event(id, "onLoadStart"));
    // Shown when it loaded: faded in over the placeholder, or at once.
    img.style.transition = "";
    img.style.opacity = fade > 0 ? "0" : "";
    this.setImageSource(img, uri, src);
    // Only an image that had to load fades in (the native backends').
    if (img.complete) img.style.opacity = "";
    this.applyTint(el);
  }

  /** `src`, an SVG, with its `currentColor` painted `color`: its blob URL,
   * or a promise while its text loads. An SVG without `currentColor`, or
   * one that does not load as text, is `src` itself. */
  svgInColor(src, color) {
    const key = `${src}\n${color}`;
    const done = this.coloredSvgs.get(key);
    if (done) return done;
    let text = this.svgTexts.get(src);
    if (text === undefined) {
      text = fetch(src).then((r) => (r.ok ? r.text() : "")).catch(() => "");
      this.svgTexts.set(src, text);
    }
    const make = (text) => {
      const url = /currentcolor/i.test(text)
        ? URL.createObjectURL(new Blob([text.replace(/currentcolor/gi, color)], { type: "image/svg+xml" }))
        : src;
      this.coloredSvgs.set(key, url);
      return url;
    };
    if (typeof text === "string") return make(text);
    return text.then((loaded) => {
      if (this.svgTexts.get(src) === text) this.svgTexts.set(src, loaded);
      return this.coloredSvgs.get(key) ?? make(loaded);
    });
  }

  /** Drops the colored copies of in-memory SVG `blob`, released. */
  forgetColoredSvgs(blob) {
    this.svgTexts.delete(blob);
    const prefix = `${blob}\n`;
    for (const [key, url] of this.coloredSvgs) {
      if (!key.startsWith(prefix)) continue;
      if (url !== blob) URL.revokeObjectURL(url);
      this.coloredSvgs.delete(key);
    }
  }

  applyTint(el) {
    if (!el._img) return;
    if (el._tint && el._src) {
      el._img.classList.add("nsh-hidden");
      const fit = el._fit;
      const size =
        fit === "fill" ? "100% 100%" : fit === "scale-down" ? "contain" : fit === "none" ? "auto" : fit || "cover";
      const mask = `url(${JSON.stringify(el._src)}) ${el._position || "center"} / ${size} no-repeat`;
      // Over the view's own background.
      swapClass(el, "_tintClass", cssClass(`background-color:${el._tint};-webkit-mask:${mask};mask:${mask};`, 3));
    } else {
      el._img.classList.toggle("nsh-hidden", !!el._failed);
      swapClass(el, "_tintClass", null);
    }
  }

  imageLoaded(el, img) {
    if (el._fade > 0) {
      img.style.transition = `opacity ${el._fade}ms linear`;
      img.style.opacity = "";
    }
    if (el._ph) {
      const ph = el._ph;
      clearTimeout(el._phTimer);
      el._phTimer = setTimeout(() => { if (el._ph === ph) ph.classList.add("nsh-hidden"); }, el._fade > 0 ? el._fade : 0);
    }
    if (el._events.has("onLoad")) this.event(el._id, "onLoad", { width: img.naturalWidth, height: img.naturalHeight });
    if (el._events.has("onLoadEnd")) this.event(el._id, "onLoadEnd");
  }

  imageFailed(el) {
    // No broken-image icon: the placeholder, or nothing, shows.
    el._failed = true;
    el._img.classList.add("nsh-hidden");
    if (el._events.has("onError")) this.event(el._id, "onError", { message: `failed to load ${el._src}` });
    if (el._events.has("onLoadEnd")) this.event(el._id, "onLoadEnd");
  }

  // Shader views. Every shader view draws on one WebGL 2 context (a page
  // gets few contexts): the program renders into its canvas at the view's
  // size, and the picture moves to the view's own canvas. A fill's canvas
  // is under its children, inside its rounded corners; an effect's and a
  // running transition's is over them (`nsh-fx-out`, the children at
  // opacity 0 under it, `nsh-fx`, keeping their pointer events), and the
  // children are its pictures (`paintTree`). A screen effect or transition
  // does the same for the whole surface (the root), and a page's or a
  // dialog's `transitionShader` runs over the stack or the root
  // (`shaderNav`). A view renders when what it reads changed (size,
  // uniforms, animated slots, pictures) or, reading the time or running a
  // transition, on every animation frame while it is in sight.

  op_sh([, id, layer]) {
    const el = this.view(id);
    if (!el) return;
    if (!layer) {
      this.dropShader(el);
      return;
    }
    const old = el._shader;
    if (old && old.layer.role !== layer.role) this.dropShader(el);
    const kept0 = el._shader;
    const words = new Uint32Array(layer.words);
    const same = kept0 && kept0.layer.key === layer.key && JSON.stringify(kept0.layer.slots) === JSON.stringify(layer.slots);
    // Animated slots keep their values while the program and slots stay.
    if (same) {
      for (const [word, kind] of layer.slots) {
        const n = kind === 3 ? 3 : kind === 4 ? 4 : 1;
        for (let i = 0; i < n; i++) if (word + i < words.length) words[word + i] = kept0.words[word + i];
      }
    }
    const now = performance.now();
    const kept = kept0 ? kept0.kept + (kept0.since != null ? now - kept0.since : 0) : 0;
    el._shader = {
      layer,
      words,
      kept,
      since: layer.paused ? null : now,
      dirty: true,
      progress: same && kept0.moved ? kept0.progress : layer.progress,
      moved: same && kept0.moved,
      running: kept0?.running ?? null,
      pictures: kept0?.pictures ?? [null, null, null, null],
      fresh: kept0?.fresh ?? [false, false, false, false],
      textures: kept0?.textures ?? [null, null, null, null],
      stale: 0,
    };
    // Bits of the pictures it reads: 1 content, 2 backdrop, 4 from, 8 to.
    el._shader.reads = layer.pictures.reduce((bits, [, input]) => bits | (1 << input), 0);
    const role = layer.role;
    const host = role >= 3 ? this.root : el;
    const draws = this.shaderDraws(layer);
    if (role === 3 && draws) this.screenShader = el;
    else if (this.screenShader === el) this.screenShader = null;
    if (!el._shaderCanvas) {
      const canvas = document.createElement("canvas");
      canvas.className = role === 0 ? "nsh-fill nsh-shader" : "nsh-fill nsh-fx-out";
      canvas._shaderOutput = true;
      if (role === 0) el.insertBefore(canvas, el.firstChild);
      else host.append(canvas);
      el._shaderCanvas = canvas;
      el._shaderVisible = true;
      if (typeof IntersectionObserver !== "undefined" && role < 3) {
        el._shaderObserver = new IntersectionObserver((entries) => {
          el._shaderVisible = entries[entries.length - 1].isIntersecting;
          if (el._shaderVisible) this.shaderDirty(el);
        });
        el._shaderObserver.observe(el);
      }
    }
    // An effect, and a screen effect, draws its children through its
    // shader always; a transition only while one runs. One that cannot
    // draw shows them as they are, as the native backends do without a GPU.
    if (!draws) this.endTransition(el);
    else if (role === 1 || role === 3) host.classList.add("nsh-fx");
    this.shaderViews.add(el);
    this.watchInputs(el);
    this.shaderDirty(el);
  }

  /** The element a shader view's pictures and output are of: the view, or the root for a screen's. */
  shaderHost(el) {
    return el._shader && el._shader.layer.role >= 3 ? this.root : el;
  }

  /** Takes a shader view's layer, canvas and watchers away. */
  dropShader(el) {
    const s = el._shader;
    if (!s) return;
    const host = this.shaderHost(el);
    if (this.screenShader === el) this.screenShader = null;
    // The root keeps it while a screen effect is on it.
    if (host !== this.root || !this.screenShader) host.classList.remove("nsh-fx");
    el._shaderCanvas?.remove();
    el._shaderCanvas = null;
    el._shaderObserver?.disconnect();
    el._shaderObserver = null;
    el._contentObserver?.disconnect();
    el._contentObserver = null;
    if (el._contentMark) {
      host.removeEventListener("scroll", el._contentMark, true);
      host.removeEventListener("load", el._contentMark, true);
      el._contentMark = null;
    }
    this.freeTextures(s);
    el._shader = null;
    this.shaderViews.delete(el);
    this.backdrops?.delete(el);
    this.watchBackdrops();
  }

  /** The core says what a shader's pictures show changed. */
  op_shi([, id]) {
    const el = this.view(id);
    const s = el?._shader;
    if (!s) return;
    s.stale |= s.reads;
    this.shaderDirty(el);
  }

  /**
   * A shader transition starts, before the rest of its batch: what shows
   * now (its children, or the transition as it is drawn) is its
   * `sample_from`, its children painted after the batch its `sample_to`,
   * and `nsh.progress` goes from 0 to 1 over `ms` on animation frames.
   */
  op_sht([, id, ms]) {
    const el = this.view(id);
    const s = el?._shader;
    if (!s || (s.layer.role !== 2 && s.layer.role !== 4) || s.failed || !this.shaderDraws(s.layer)) return;
    const host = this.shaderHost(el);
    const box = this.shaderBox(el);
    if (!box) return;
    const from = this.pictureCanvas(el, 2, box);
    if (s.running && el._shaderCanvas.width) {
      // What the running one shows.
      from.cx.setTransform(1, 0, 0, 1, 0, 0);
      from.cx.drawImage(el._shaderCanvas, 0, 0, from.canvas.width, from.canvas.height);
    } else {
      this.paintHost(from.cx, host, host.getBoundingClientRect(), null, host);
    }
    s.fresh[2] = true;
    s.running = { start: performance.now(), ms: Math.max(1, ms), reverse: false };
    // Its children after the batch, on the next frame; until then what it
    // drew before.
    s.pictures[3] = null;
    s.fresh[3] = true;
    s.stale |= 8;
    host.classList.add("nsh-fx");
    if (this.renderShader(el, performance.now())) this.shaderDirty(el);
    else this.shaderFailed(el);
  }

  /** A page's or a dialog's `transitionShader` (`layer`, `ms`), or none. */
  op_shn([, id, layer, ms]) {
    const el = this.view(id);
    if (!el) return;
    el._navShader = layer ? { layer, ms } : null;
  }

  /**
   * A page's or a dialog's change through its `transitionShader` over
   * `host` (the stack, the root): `upper` (the page that comes or goes,
   * the dialog) and what is before it is its `sample_to`, what is before it
   * alone its `sample_from`, and `nsh.progress` how much of the upper side
   * shows: 0 to 1, or 1 to 0 when `reverse`. The views are where they end
   * at once under it. Calls `done` when it ends; false where it cannot run
   * (`shaderDraws`, or a first frame the browser refuses) and when the
   * user asks for less motion: the page's or the dialog's own motion runs
   * then. One that still runs over `host` ends first (its `done` runs), so
   * the new one starts from where it ends.
   */
  shaderNav(host, upper, nav, reverse, done) {
    this.endNavShader(host);
    if (this.reduceMotion()) return false;
    const r = host.getBoundingClientRect();
    if (!r.width || !r.height || !this.shaderDraws(nav.layer)) return false;
    const o = document.createElement("div");
    o.className = "nsh-nav-shader";
    Object.assign(o.style, { position: "absolute", left: "0", top: "0", width: `${r.width}px`, height: `${r.height}px`, zIndex: "2147483001", pointerEvents: "none" });
    const canvas = document.createElement("canvas");
    canvas.className = "nsh-fill";
    canvas._shaderOutput = true;
    o.append(canvas);
    const layer = { ...nav.layer, role: 2, overflow: 0 };
    o._frame = [0, 0, r.width, r.height];
    o._shaderCanvas = canvas;
    o._shaderVisible = true;
    o._shader = {
      layer,
      words: new Uint32Array(layer.words),
      kept: 0,
      since: performance.now(),
      dirty: true,
      progress: reverse ? 1 : 0,
      running: {
        start: performance.now(),
        ms: Math.max(1, nav.ms),
        reverse,
        done: () => {
          o.remove();
          if (host._navOverlay === o) host._navOverlay = null;
          done?.();
        },
      },
      pictures: [null, null, null, null],
      fresh: [false, false, true, true],
      textures: [null, null, null, null],
      stale: 0,
      reads: 0,
      nav: true,
    };
    const from = this.pictureCanvas(o, 2, [r.width, r.height, 0]);
    this.paintHost(from.cx, host, r, upper, null);
    const to = this.pictureCanvas(o, 3, [r.width, r.height, 0]);
    this.paintHost(to.cx, host, r, null, null);
    host.append(o);
    if (!this.renderShader(o, performance.now())) {
      o.remove();
      this.freeTextures(o._shader);
      return false;
    }
    host._navOverlay = o;
    this.shaderViews.add(o);
    this.shaderDirty(o);
    // Its frames end it (`shaderFrame`); without them (a hidden tab) this
    // does, and the change is reported on time all the same.
    const running = o._shader.running;
    setTimeout(() => { if (o._shader.running === running) this.endTransition(o); }, running.ms + LATE_MS);
    return true;
  }

  /**
   * A page's or a dialog's change through its shader that still runs over
   * `host` (a stack, the root) ends at once, settled and reported: another
   * change of it starts from there.
   */
  endNavShader(host) {
    const o = host?._navOverlay;
    if (o?._shader?.running) this.endTransition(o);
  }

  /**
   * Paints `host`'s children up to `stop` for a picture: an effect's (or
   * the root with a screen effect) as they show without the effect.
   */
  paintHost(cx, host, r, stop, owner) {
    this.watchPaint();
    // What changed since the last picture: its styles are read again.
    this.touchAll(this._paintObserver.takeRecords());
    let touched = 0;
    for (let n = host; n; n = n.parentElement) touched = Math.max(touched, n._touched ?? 0);
    const lifted = host.classList.contains("nsh-fx");
    if (lifted) {
      host.classList.add("nsh-painting");
      host.classList.remove("nsh-fx");
    }
    try {
      this.paintTree(cx, host, r, 1, stop, owner, touched);
    } finally {
      if (lifted) {
        host.classList.add("nsh-fx");
        host.classList.remove("nsh-painting");
      }
      // Lifting and putting back the host's class is the picture's own
      // doing, which changes no style it keeps.
      this._paintObserver.takeRecords();
    }
  }

  /**
   * Notices the changes in the surface that make a kept paint style
   * (`paintStyle`) stale: each mutation stamps its element (`_touched`),
   * which stales its own style and its descendants'; a change of the color
   * scheme stales all.
   */
  watchPaint() {
    if (this._paintObserver) return;
    this.paintGen = 0;
    this.paintReset = 0;
    this._paintObserver = new MutationObserver((list) => this.touchAll(list));
    this._paintObserver.observe(this.root, { subtree: true, childList: true, attributes: true });
    this._paintScheme = () => {
      this.paintReset = ++this.paintGen;
    };
    globalThis.matchMedia?.("(prefers-color-scheme: dark)").addEventListener?.("change", this._paintScheme);
  }

  /** Stamps the elements `list`'s mutations changed (`watchPaint`). */
  touchAll(list) {
    for (const m of list) if (m.type !== "characterData") m.target._touched = ++this.paintGen;
  }

  /**
   * What `el` paints with from its computed style, kept until a change
   * reaches it: `touched` is the newest stamp of it and its ancestors
   * (`watchPaint`), so a picture taken again reads the styles of what
   * changed only.
   */
  paintStyle(el, touched) {
    const kept = el._paintStyle;
    if (kept && kept.stamp >= touched && kept.stamp >= this.paintReset) return kept;
    const cs = getComputedStyle(el);
    const bg = cs.backgroundColor;
    const bw = parseFloat(cs.borderTopWidth) || 0;
    const style = {
      stamp: this.paintGen,
      shown: cs.display !== "none",
      opacity: Number(cs.opacity),
      hidden: cs.visibility === "hidden",
      radii: [cs.borderTopLeftRadius, cs.borderTopRightRadius, cs.borderBottomRightRadius, cs.borderBottomLeftRadius]
        .map((v) => parseFloat(v) || 0),
      background: bg && bg !== "transparent" && !/rgba\([^)]*,\s*0\)$/.test(bg) ? bg : null,
      border: bw > 0 && cs.borderTopStyle !== "none" && cs.borderTopStyle !== "hidden" ? [bw, cs.borderTopColor] : null,
      clips: cs.overflowX !== "visible" || cs.overflowY !== "visible",
      font: cs.font,
      color: cs.color,
      objectFit: cs.objectFit,
    };
    el._paintStyle = style;
    return style;
  }

  /** A shader view's box: its size in points and its overflow, `[w, h, m]`. */
  shaderBox(el) {
    const s = el._shader;
    if (s.layer.role >= 3) return this.size?.[0] > 0 ? [this.size[0], this.size[1], 0] : null;
    if (!el._frame) return null;
    return [el._frame[2], el._frame[3], Math.max(0, s.layer.overflow || 0)];
  }

  /** The canvas of a view's picture `input`, covering its box and the overflow around it; its context in points from the view's top-left. */
  pictureCanvas(el, input, [w, h, m]) {
    const s = el._shader;
    const ratio = devicePixelRatio || 1;
    const c = (s.pictures[input] ??= document.createElement("canvas"));
    const pw = Math.max(1, Math.round((w + 2 * m) * ratio));
    const ph = Math.max(1, Math.round((h + 2 * m) * ratio));
    const cx = c.getContext("2d");
    // Setting a canvas's size reallocates it: only when the size changes,
    // else the picture is cleared and drawn again in place.
    if (c.width !== pw || c.height !== ph) {
      c.width = pw;
      c.height = ph;
    } else {
      cx.setTransform(1, 0, 0, 1, 0, 0);
      cx.clearRect(0, 0, pw, ph);
    }
    cx.setTransform(ratio, 0, 0, ratio, m * ratio, m * ratio);
    s.fresh[input] = true;
    return { canvas: c, cx };
  }

  /** Watches what a view's shader pictures: its children (or the surface for a screen's) and what is behind it. */
  watchInputs(el) {
    const s = el._shader;
    const role = s.layer.role;
    const host = this.shaderHost(el);
    const content = role !== 0 && (s.reads & (role === 2 || role === 4 ? 8 : 1));
    const backdrop = s.reads & 2;
    if (content && !el._contentObserver) {
      const mark = (list) => {
        if (list && !this.shownChange(list)) return;
        if (!el._shader) return;
        el._shader.stale |= el._shader.reads & 9;
        this.shaderDirty(el);
      };
      el._contentObserver = new MutationObserver(mark);
      el._contentObserver.observe(host, { subtree: true, childList: true, attributes: true, attributeOldValue: true, characterData: true });
      el._contentMark = () => mark();
      host.addEventListener("scroll", el._contentMark, true);
      host.addEventListener("load", el._contentMark, true);
    }
    this.backdrops ??= new Set();
    if (backdrop) this.backdrops.add(el);
    else this.backdrops.delete(el);
    this.watchBackdrops();
    s.stale |= s.reads;
  }

  /** Whether mutations change what shows: not a shader's own canvas, nor painting's class toggles (`paintHost`). */
  shownChange(list) {
    const plain = (c) => (c ?? "").split(" ").filter((n) => n && n !== "nsh-fx" && n !== "nsh-painting").join(" ");
    return list.some((m) => !(m.target._shaderOutput || m.target.parentElement?._shaderOutput ||
      (m.type === "attributes" && m.attributeName === "class" && plain(m.oldValue) === plain(m.target.getAttribute("class")))));
  }

  /** A change anywhere in the surface changes what is behind every backdrop shader. */
  watchBackdrops() {
    const backdrops = this.backdrops ?? new Set();
    for (const el of backdrops) if (!el._shader) backdrops.delete(el);
    const wanted = backdrops.size > 0;
    if (wanted && !this._backdropObserver) {
      const mark = (list) => {
        if (list && !this.shownChange(list)) return;
        for (const el of this.backdrops) {
          if (!el._shader) continue;
          el._shader.stale |= 2;
          this.shaderDirty(el);
        }
      };
      this._backdropObserver = new MutationObserver(mark);
      this._backdropObserver.observe(this.root, { subtree: true, childList: true, attributes: true, attributeOldValue: true, characterData: true });
      this._backdropMark = () => mark();
      this.root.addEventListener("scroll", this._backdropMark, true);
      this.root.addEventListener("load", this._backdropMark, true);
    } else if (!wanted && this._backdropObserver) {
      this._backdropObserver.disconnect();
      this.root.removeEventListener("scroll", this._backdropMark, true);
      this.root.removeEventListener("load", this._backdropMark, true);
      this._backdropObserver = this._backdropMark = null;
    }
  }

  /** Paints the pictures a view's shader reads that changed: its children (content, or a running transition's `to`) and what is behind it. */
  paintInputs(el) {
    const s = el._shader;
    const stale = s.stale;
    s.stale = 0;
    const role = s.layer.role;
    const box = this.shaderBox(el);
    if (!stale || !box || s.nav) return;
    const transition = role === 2 || role === 4;
    const host = this.shaderHost(el);
    const base = host.getBoundingClientRect();
    const children = transition ? (s.running ? stale & 8 : 0) : role !== 0 ? stale & 1 : 0;
    if (children) {
      const { cx } = this.pictureCanvas(el, transition ? 3 : 0, box);
      this.paintHost(cx, host, base, null, host);
    }
    if (stale & 2) {
      const { cx } = this.pictureCanvas(el, 1, box);
      // The surface up to the view (what draws after it is above it), as
      // it shows without a screen effect.
      this.paintHost(cx, this.root, el.getBoundingClientRect(), el, this.root);
    }
  }

  /**
   * Paints `node`'s children into `cx`, in points from `base`'s top-left:
   * backgrounds, rounded corners, uniform borders, images, canvases (other
   * shaders' pictures among them), text runs and their clipping, with
   * their opacities. Stops at `stop` (returns true); skips `owner`'s own
   * shader canvas. Rotations, gradients and shadows are left out.
   */
  paintTree(cx, node, base, opacity, stop, owner, touched = Infinity) {
    for (const child of node.children) {
      if (child === stop) return true;
      if (child._shaderOutput && (child.parentElement === owner || child.classList.contains("nsh-fx-out") && !child.parentElement.classList.contains("nsh-fx"))) continue;
      if (child.classList.contains("nsh-nav-shader")) continue;
      const stamp = Math.max(touched, child._touched ?? 0);
      const cs = this.paintStyle(child, stamp);
      if (!cs.shown) continue;
      const alpha = opacity * cs.opacity;
      if (alpha <= 0 || cs.hidden) {
        if (stop && child.contains(stop)) return true;
        continue;
      }
      // Boxes come from the layout the first one reads (painting writes
      // nothing that would lay it out again).
      const r = child.getBoundingClientRect();
      const x = r.left - base.left, y = r.top - base.top, w = r.width, h = r.height;
      const radii = cs.radii.map((v) => Math.min(v, w / 2, h / 2));
      const shape = () => {
        cx.beginPath();
        cx.roundRect(x, y, w, h, radii);
      };
      cx.save();
      cx.globalAlpha = alpha;
      if (cs.background) {
        cx.fillStyle = cs.background;
        shape();
        cx.fill();
      }
      if (cs.border) {
        const [bw, color] = cs.border;
        cx.strokeStyle = color;
        cx.lineWidth = bw;
        cx.beginPath();
        cx.roundRect(x + bw / 2, y + bw / 2, Math.max(0, w - bw), Math.max(0, h - bw), radii.map((v) => Math.max(0, v - bw / 2)));
        cx.stroke();
      }
      if (child.tagName === "IMG") {
        if (child.complete && child.naturalWidth && this.paintable(child)) this.paintImage(cx, child, cs, x, y, w, h, radii);
      } else if (child.tagName === "CANVAS") {
        // One a cross-origin image tainted (`draw`) would taint the
        // picture, which WebGL then refuses to upload.
        if (child.width && child.height && !child._tainted) {
          // A fill's canvas inherits its view's rounded corners.
          cx.save();
          shape();
          cx.clip();
          cx.drawImage(child, x, y, w, h);
          cx.restore();
        }
      } else if (child.classList.contains("nsh-run")) {
        cx.font = cs.font;
        cx.fillStyle = cs.color;
        cx.textBaseline = "alphabetic";
        const text = child.textContent;
        const m = cx.measureText(text);
        cx.fillText(text, x, y + (m.fontBoundingBoxAscent ?? m.actualBoundingBoxAscent));
      }
      // A view that clips its content (a scroll view among them) clips it here too.
      if (cs.clips) {
        shape();
        cx.clip();
      }
      const done = this.paintTree(cx, child, base, alpha, stop, owner, stamp);
      cx.restore();
      if (done) return true;
    }
    return false;
  }

  /** Whether an image can be painted without tainting the picture (same origin, `data:` or CORS). */
  paintable(img) {
    const src = img.currentSrc || img.src;
    // A `data:` URL's origin reads "null", but its image never taints.
    if (src.startsWith("data:")) return true;
    try {
      return new URL(src, location.href).origin === location.origin || img.crossOrigin != null;
    } catch {
      return false;
    }
  }

  /** An image in its box, fitted as its `object-fit` says. */
  paintImage(cx, img, cs, x, y, w, h, radii) {
    const iw = img.naturalWidth, ih = img.naturalHeight;
    let dw = w, dh = h;
    const fit = cs.objectFit;
    if (fit === "contain" || fit === "cover" || fit === "scale-down") {
      const s = fit === "cover" ? Math.max(w / iw, h / ih) : Math.min(w / iw, h / ih, fit === "scale-down" ? 1 : Infinity);
      dw = iw * s;
      dh = ih * s;
    } else if (fit === "none") {
      dw = iw;
      dh = ih;
    }
    cx.save();
    cx.beginPath();
    cx.roundRect(x, y, w, h, radii);
    cx.clip();
    cx.drawImage(img, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
    cx.restore();
  }

  /** Writes an animated value into its slot (`op_a`'s `canvas:N`): a number, or a CSS color; the progress slot moves `nsh.progress`. */
  shaderSlot(el, slot, value) {
    const s = el._shader;
    if (slot === s.layer.progressSlot) {
      s.progress = Number(value);
      s.moved = true;
      this.shaderDirty(el);
      return;
    }
    const entry = s.layer.slots[slot];
    if (!entry) return;
    const [word, kind] = entry;
    // A view of the words as floats, kept while they are the same words.
    if (s.f32?.buffer !== s.words.buffer) s.f32 = new Float32Array(s.words.buffer);
    const f32 = s.f32;
    if (kind >= 3) {
      const c = parseCssColor(value);
      for (let i = 0; i < (kind === 3 ? 3 : 4); i++) f32[word + i] = c[i];
    } else if (kind === 0) {
      f32[word] = Number(value);
    } else {
      s.words[word] = kind === 1 ? Math.trunc(Number(value)) | 0 : Math.max(0, Math.trunc(Number(value))) >>> 0;
    }
    this.shaderDirty(el);
  }

  shaderDirty(el) {
    if (el._shader) el._shader.dirty = true;
    if (this.shaderFrameQueued) return;
    this.shaderFrameQueued = true;
    requestAnimationFrame((t) => this.shaderFrame(t));
  }

  shaderFrame(t) {
    this.shaderFrameQueued = false;
    // A loss or a restore whose event has not come yet (`shaderLost`).
    const gl = this._shaderGl;
    if (gl && gl.isContextLost() !== Boolean(this._shaderLost)) {
      if (this._shaderLost) this.shaderRestored();
      else this.shaderLost();
    }
    let again = false;
    const now = performance.now();
    for (const el of [...this.shaderViews]) {
      const s = el._shader;
      if (!s) {
        this.shaderViews.delete(el);
        continue;
      }
      if (s.layer.role >= 3 && !s.nav) this.screenShown(el);
      if (!el.isConnected) {
        // A page's or a dialog's overlay whose host went: it ends.
        if (s.nav || s.running) this.endTransition(el);
        continue;
      }
      if (s.running && now - s.running.start >= s.running.ms) {
        this.endTransition(el);
        continue;
      }
      const runs = (s.layer.animated && s.since != null) || Boolean(s.running);
      if (!el._shaderVisible || !(s.dirty || runs || s.stale)) continue;
      s.dirty = false;
      // One that cannot draw paints no pictures and takes no frames.
      if (s.failed || !this.shaderDraws(s.layer)) continue;
      if (s.stale) this.paintInputs(el);
      if (!this.renderShader(el, now)) {
        this.shaderFailed(el);
        continue;
      }
      again ||= runs;
    }
    this.fitSharedCanvas(now);
    // A view this frame marked (a screen effect another shader drew under,
    // `shaderDirty`) has queued the next one already: a second callback
    // would run the next frame twice, and each of those twice again.
    if (again && !this.shaderFrameQueued) {
      this.shaderFrameQueued = true;
      requestAnimationFrame((t) => this.shaderFrame(t));
    }
  }

  /**
   * A screen effect's or transition's canvas is on the root, outside its
   * view: it shows while the view is in the surface (a view removed, such
   * as with its page, may come back).
   */
  screenShown(el) {
    const shown = el.isConnected;
    const canvas = el._shaderCanvas;
    if (!canvas || canvas.hidden === !shown) return;
    canvas.hidden = !shown;
    if (el._shader.layer.role !== 3) return;
    if (shown && !el._shader.failed && this.shaderDraws(el._shader.layer)) this.screenShader = el;
    else if (this.screenShader === el) this.screenShader = null;
    this.root.classList.toggle("nsh-fx", Boolean(this.screenShader));
  }

  /**
   * A view whose frame the browser refused (`renderShader`) shows its
   * children as they are, as one that cannot draw, until its next layer
   * (`op_sh`) tries again; a page's or a dialog's change ends at once.
   */
  shaderFailed(el) {
    el._shader.failed = true;
    if (this.screenShader === el) this.screenShader = null;
    this.endTransition(el);
  }

  /**
   * A transition ended, or a view's shader cannot draw: its children show
   * as they are (a page's or a dialog's overlay goes).
   */
  endTransition(el) {
    const s = el._shader;
    const run = s.running;
    s.running = null;
    if (s.nav) {
      // The overlay goes for good, and its pictures' textures with it:
      // GPU memory the garbage collector does not see.
      this.freeTextures(s);
      this.shaderViews.delete(el);
      run?.done?.();
      return;
    }
    const host = this.shaderHost(el);
    if (host !== this.root || !this.screenShader) host.classList.remove("nsh-fx");
    s.pictures[2] = s.pictures[3] = null;
    this.freeTextures(s, [2, 3]);
    const canvas = el._shaderCanvas;
    canvas.width = 0;
  }

  /** Deletes the textures of a view's pictures `inputs` (all of them by default). */
  freeTextures(s, inputs = [0, 1, 2, 3]) {
    const gl = this._shaderGl;
    for (const input of inputs) {
      const t = s.textures[input];
      if (t && gl) gl.deleteTexture(t);
      s.textures[input] = null;
    }
  }

  /** The shared WebGL 2 context; `null` where there is none (said once). */
  shaderGl() {
    if (this._shaderGl !== undefined) return this._shaderGl;
    const canvas = typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(1, 1) : document.createElement("canvas");
    const gl = canvas.getContext("webgl2", { premultipliedAlpha: true, antialias: false, preserveDrawingBuffer: false });
    if (!gl) {
      console.warn("[nsh] shaders: no WebGL 2; shader views draw nothing");
    } else {
      // The browser takes the context away on a GPU reset or when it
      // evicts the tab's; `preventDefault` asks for it back.
      canvas.addEventListener("webglcontextlost", (e) => {
        e.preventDefault();
        this.shaderLost();
      });
      canvas.addEventListener("webglcontextrestored", () => this.shaderRestored());
    }
    this._shaderGl = gl;
    this._shaderPrograms = new Map();
    // The app's `shadersAvailable()` turns false.
    if (!gl) this.environmentChanged();
    return gl;
  }

  /**
   * The shared canvas, at least `pw` × `ph` pixels: each view draws into
   * its top-left corner. Setting its size reallocates its drawing buffer,
   * so it fits the largest view that draws rather than each in turn (a
   * screen effect drawn among small shaders would resize it twice a
   * frame), and shrinks only once the views have needed less for a while
   * (`fitSharedCanvas`).
   */
  sharedCanvas(gl, pw, ph) {
    const canvas = gl.canvas;
    const need = (this._shaderNeed ??= [0, 0]);
    need[0] = Math.max(need[0], pw);
    need[1] = Math.max(need[1], ph);
    if (canvas.width < pw) canvas.width = pw;
    if (canvas.height < ph) canvas.height = ph;
    return canvas;
  }

  /**
   * After a frame that drew: the shared canvas shrinks to the largest view
   * drawn since it became larger than needed, a second on.
   */
  fitSharedCanvas(now) {
    const need = this._shaderNeed;
    this._shaderNeed = null;
    // A view drew: the context is there.
    const canvas = need && this.shaderGl()?.canvas;
    if (!canvas) return;
    if (canvas.width <= need[0] && canvas.height <= need[1]) {
      this._shaderSmaller = null;
      return;
    }
    const smaller = (this._shaderSmaller ??= { since: now, size: [0, 0] });
    smaller.size = [Math.max(smaller.size[0], need[0]), Math.max(smaller.size[1], need[1])];
    if (now - smaller.since < 1000) return;
    this._shaderSmaller = null;
    [canvas.width, canvas.height] = smaller.size;
  }

  /**
   * Whether `layer`'s shader draws: there is WebGL 2, its context is not
   * lost, and the driver takes its program. Effects and transitions hide
   * their children under their canvas only then.
   */
  shaderDraws(layer) {
    const gl = this.shaderGl();
    return Boolean(gl && !gl.isContextLost() && this.shaderProgram(gl, layer));
  }

  /**
   * The shared context is lost: what was made on it went with it, and
   * every shader view shows its children as one that cannot draw does (a
   * running change ends, settled and reported) until it comes back.
   */
  shaderLost() {
    if (this._shaderLost) return;
    this._shaderLost = true;
    console.warn("[nsh] shaders: the WebGL context was lost; shader views show their children until it is back");
    this._shaderPrograms = new Map();
    this._emptyTexture = null;
    this.screenShader = null;
    this.root.classList.remove("nsh-fx");
    for (const el of [...this.shaderViews]) {
      const s = el._shader;
      if (!s) continue;
      s.textures = [null, null, null, null];
      this.endTransition(el);
    }
  }

  /**
   * The shared context is back: programs and textures are made again as
   * the views draw, and effects hide their children under their canvas
   * again.
   */
  shaderRestored() {
    if (!this._shaderLost) return;
    this._shaderLost = false;
    // Programs the driver refused while the context was gone are tried again.
    this._shaderPrograms = new Map();
    this._emptyTexture = null;
    for (const el of this.shaderViews) {
      const s = el._shader;
      if (!s) continue;
      s.textures = [null, null, null, null];
      s.stale |= s.reads;
      const role = s.layer.role;
      if ((role === 1 || role === 3) && !s.failed && el.isConnected && this.shaderDraws(s.layer)) {
        if (role === 3) this.screenShader = el;
        this.shaderHost(el).classList.add("nsh-fx");
      }
      this.shaderDirty(el);
    }
  }

  shaderProgram(gl, layer) {
    const cached = this._shaderPrograms.get(layer.key);
    if (cached !== undefined) return cached;
    const compile = (type, source) => {
      const shader = gl.createShader(type);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        console.warn("[nsh] shader:", gl.getShaderInfoLog(shader));
        return null;
      }
      return shader;
    };
    let program = null;
    const vs = compile(gl.VERTEX_SHADER, layer.vs);
    const fs = vs && compile(gl.FRAGMENT_SHADER, layer.fs);
    if (fs) {
      program = gl.createProgram();
      gl.attachShader(program, vs);
      gl.attachShader(program, fs);
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        console.warn("[nsh] shader:", gl.getProgramInfoLog(program));
        program = null;
      }
    }
    let entry = null;
    if (program) {
      const block = (name, binding) => {
        if (!name) return null;
        const index = gl.getUniformBlockIndex(program, name);
        if (index === gl.INVALID_INDEX) return null;
        gl.uniformBlockBinding(program, index, binding);
        return gl.createBuffer();
      };
      const samplers = (layer.pictures ?? []).map(([name, input]) => [gl.getUniformLocation(program, name), input]);
      entry = { program, builtins: block(layer.nsh, 0), uniforms: block(layer.u, 1), samplers, vao: gl.createVertexArray() };
    }
    this._shaderPrograms.set(layer.key, entry);
    return entry;
  }

  /** The texture of picture `input` (transparent without one), uploaded again after a paint. */
  shaderTexture(gl, s, input) {
    const picture = s.pictures[input];
    if (!picture) {
      if (!this._emptyTexture) {
        this._emptyTexture = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, this._emptyTexture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
      }
      return this._emptyTexture;
    }
    let t = s.textures[input];
    if (!t) {
      t = s.textures[input] = gl.createTexture();
      s.fresh[input] = true;
    }
    gl.bindTexture(gl.TEXTURE_2D, t);
    if (s.fresh[input]) {
      s.fresh[input] = false;
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
      try {
        // Throws for a tainted picture (`renderShader`).
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, picture);
      } finally {
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      }
      for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) {
        gl.texParameteri(gl.TEXTURE_2D, k, v);
      }
    }
    return t;
  }

  /**
   * Draws a view's frame: false when the browser refuses it, as WebGL
   * refuses to upload a tainted picture (a canvas a cross-origin image
   * tainted where `paintTree` could not tell). The caller shows the
   * children then (`shaderFailed`), and the frame, or the batch it was
   * drawn in, goes on with the other views.
   */
  renderShader(el, t) {
    try {
      this.drawShader(el, t);
      return true;
    } catch (err) {
      console.warn("[nsh] shader:", err);
      return false;
    }
  }

  drawShader(el, t) {
    const s = el._shader;
    const gl = this.shaderGl();
    if (!gl) return;
    const box = this.shaderBox(el);
    if (!box) return;
    const program = this.shaderProgram(gl, s.layer);
    if (!program) return;
    const role = s.layer.role;
    // A transition draws through its shader only while one runs.
    if ((role === 2 || role === 4) && !s.running) return;
    const [w, h, m] = box;
    let ratio = (devicePixelRatio || 1) * Math.min(4, this.zoomOf(el));
    ratio = Math.min(ratio, 4096 / Math.max(w + 2 * m, h + 2 * m, 1));
    const pw = Math.max(1, Math.round((w + 2 * m) * ratio));
    const ph = Math.max(1, Math.round((h + 2 * m) * ratio));
    const canvas = this.sharedCanvas(gl, pw, ph);
    const time = (s.kept + (s.since != null ? t - s.since : 0)) / 1000;
    let progress = s.progress;
    if (s.running) {
      const p = Math.min(1, Math.max(0, (t - s.running.start) / s.running.ms));
      progress = s.running.reverse ? 1 - p : p;
    }
    // Its top-left corner of the shared canvas (GL's y goes up).
    gl.viewport(0, canvas.height - ph, pw, ph);
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(0, canvas.height - ph, pw, ph);
    gl.useProgram(program.program);
    gl.bindVertexArray(program.vao);
    if (program.builtins) {
      gl.bindBuffer(gl.UNIFORM_BUFFER, program.builtins);
      // `struct Nsh` (core's `shader::builtins`, 32 bytes): size, time,
      // scale, progress and overflow.
      const builtins = (s.builtins ??= new Float32Array(8));
      builtins.set([w, h, Math.max(0, time), pw / Math.max(w + 2 * m, 1e-6), progress, m, 0, 0]);
      gl.bufferData(gl.UNIFORM_BUFFER, builtins, gl.DYNAMIC_DRAW);
      gl.bindBufferBase(gl.UNIFORM_BUFFER, 0, program.builtins);
    }
    if (program.uniforms) {
      gl.bindBuffer(gl.UNIFORM_BUFFER, program.uniforms);
      gl.bufferData(gl.UNIFORM_BUFFER, s.words, gl.DYNAMIC_DRAW);
      gl.bindBufferBase(gl.UNIFORM_BUFFER, 1, program.uniforms);
    }
    program.samplers.forEach(([location, input], unit) => {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, this.shaderTexture(gl, s, input));
      gl.uniform1i(location, unit);
    });
    gl.disable(gl.BLEND);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    const target = el._shaderCanvas;
    if (target.width !== pw || target.height !== ph) {
      target.width = pw;
      target.height = ph;
    }
    if (role !== 0 && role < 3) {
      // Over its box and the overflow around it.
      const st = target.style;
      const left = `${-m}px`;
      if (st.left !== left || st.width !== `${w + 2 * m}px` || st.height !== `${h + 2 * m}px`) {
        [st.left, st.top, st.width, st.height] = [left, left, `${w + 2 * m}px`, `${h + 2 * m}px`];
      }
    }
    // A copy on the GPU of its corner, which the next view draws over.
    target._2d ??= target.getContext("2d");
    target._2d.globalCompositeOperation = "copy";
    target._2d.drawImage(canvas, 0, 0, pw, ph, 0, 0, pw, ph);
    // A screen effect pictures what shaders in the surface drew.
    const screen = this.screenShader;
    if (screen && screen !== el && screen._shader && role !== 3 && !s.nav) {
      screen._shader.stale |= 1;
      if (!screen._shader.dirty) this.shaderDirty(screen);
    }
  }

  // Scroll views

  op_sc([, id, horizontal, indicator, , replaced]) {
    const el = this.view(id);
    if (!el) return;
    el._horizontal = horizontal;
    el._indicator = indicator;
    el._replaced = replaced;
    this.scrollOverflow(el);
    el.classList.toggle("nsh-noindicator", !indicator);
    if (el._bar && !this.barShown(el)) this.showBar(el);
  }

  op_scs([, id, w, h]) {
    const el = this.view(id);
    if (!el?._spacer) return;
    el._content = [w, h];
    this.scrollFits(el);
    this.placeLayer(el);
    this.snapMarkers(el);
    // The last sticky cell travels to the end of the content.
    for (const cell of el._tracks?.values() ?? []) this.placeTrack(cell);
  }

  op_sb([, id, dx, dy]) {
    const el = this.view(id);
    if (!el) return;
    el._applied++;
    // A scroll animation of the core's in flight moves with the content,
    // as on the native backends (`nsh-core`'s `shifted`): it goes on from
    // the content it was on.
    const s = el._smooth;
    if (s) {
      s.fromX += dx;
      s.fromY += dy;
      s.x += dx;
      s.y += dy;
    }
    // So does a glide of the wheel's or the keys' (`scrollSmoothly`):
    // its next frame would put the offset back.
    const a = el._glide;
    if (a) {
      a.x += dx;
      a.y += dy;
      if (a.at) a.at = [a.at[0] + dx, a.at[1] + dy];
    }
    el.scrollLeft += dx;
    el.scrollTop += dy;
  }

  op_sbh([, id, behavior]) {
    const el = this.view(id);
    if (!el) return;
    const refresh = el._behavior?.refreshIndicator?.height !== behavior.refreshIndicator?.height;
    const bar = String(this.barInset(el)) !== String(behavior.bar ?? [0, 0, 0, 0]);
    el._behavior = behavior;
    // The browser's own indicator (phones) keeps its track within the
    // insets where its scroll bar can be styled (`.nsh-scroll`'s track).
    if (bar) {
      const [top, right, bottom, left] = this.barInset(el);
      el.style.setProperty("--nsh-bar-t", `${top}px`);
      el.style.setProperty("--nsh-bar-r", `${right}px`);
      el.style.setProperty("--nsh-bar-b", `${bottom}px`);
      el.style.setProperty("--nsh-bar-l", `${left}px`);
    }
    // A refresh in progress keeps the room of the indicator now showing.
    if (refresh && el._refreshing && !el._pulling && el._pull > 0) this.animatePull(el, this.refreshSpace(el));
    if (refresh) this.updateSpinner(el);
    if (this.zooms(el)) {
      this.ensureLayer(el);
      el._zoom = Math.min(Math.max(el._zoom, behavior.minZoom), behavior.maxZoom);
      this.placeLayer(el);
    }
    this.scrollOverflow(el);
    this.snapMarkers(el);
  }

  /** Scrolls only along the view's axis, and not at all while scrolling is
   * disabled. With `overflow: auto` on both axes, a vertical view's own bar
   * narrows it below its content's laid-out width and adds a horizontal bar.
   * Inline, over the style's `overflow`. */
  scrollOverflow(el) {
    const scroll = el._behavior?.enabled === false ? "hidden" : "auto";
    // Zoomable content scrolls both ways, panned and pinched here (touch-action none).
    const zooms = this.zooms(el);
    const axes = scroll === "hidden" ? "nsh-onone" : zooms ? "nsh-oxy" : el._horizontal ? "nsh-ox" : "nsh-oy";
    swapClass(el, "_overflow", axes);
    el.classList.toggle("nsh-zoom", zooms);
    this.scrollFits(el);
  }

  /** Whether the content of scroll view `el` fits along its axis, which
   * leaves it nothing to scroll (`nsh-fits`): its overscroll is the scroll
   * view's around it then, as a native Android scroll view hands its parent
   * what it cannot take. A zoomable view keeps its own. */
  scrollFits(el) {
    const axis = el._horizontal ? 0 : 1;
    const fits = !!el._content && !!el._frame && !this.zooms(el) && el._content[axis] <= el._frame[2 + axis] + 0.5;
    el.classList.toggle("nsh-fits", fits);
  }

  snapMarkers(el) {
    const b = el._behavior;
    for (const m of el._markers ?? []) m.remove();
    el._markers = [];
    el._snapPoints = null;
    el.classList.remove("nsh-snap-x", "nsh-snap-y");
    if (!b || !el._content || !el._frame) return;
    const axis = el._horizontal ? 0 : 1;
    const viewport = el._frame[2 + axis];
    const max = Math.max(0, el._content[axis] - viewport);
    let points = [];
    if (b.snapInterval > 0) {
      const interval = b.snapInterval;
      const shift = b.snapAlignment === "center" ? (viewport - interval) / 2
        : b.snapAlignment === "end" ? viewport - interval : 0;
      const count = Math.max(0, Math.ceil((max + shift) / interval));
      for (let i = 0; i <= count; i++) points.push(Math.min(max, Math.max(0, i * interval - shift)));
    } else if (b.snapOffsets.length) points = b.snapOffsets.map(p => Math.min(max, Math.max(0, p)));
    else if (b.paging && viewport > 0) {
      for (let i = 0; i <= Math.ceil(max / viewport); i++) points.push(Math.min(max, i * viewport));
    }
    if (!points.length) return;
    el._snapPoints = [...points].sort((a, b) => a - b);
    el.classList.add(el._horizontal ? "nsh-snap-x" : "nsh-snap-y");
    for (const p of points) {
      const m = document.createElement("div");
      m.className = b.paging || b.snapInterval > 0 ? "nsh-snap nsh-snap-stop" : "nsh-snap";
      m.style.cssText = el._horizontal ? `left:${p}px` : `top:${p}px`;
      el.append(m);
      el._markers.push(m);
    }
  }

  // Sticky list cells stick with the browser's `position: sticky`, so they
  // move with its scrolling, in step with the compositor; a shift set from
  // the page's scroll events trails it by a frame. Each sits in a track
  // spanning its range of travel, from its frame to the scroll offset
  // `end` plus its size, out of which the next sticky cell pushes it.

  op_sticky([, id, cells]) {
    const el = this.view(id);
    if (!el) return;
    const tracks = (el._tracks ??= new Map());
    const ranges = new Map(cells.map(([cellId, start, end]) => [cellId, [start, end]]));
    el.classList.toggle("nsh-sticky", ranges.size > 0);
    // Cells no longer sticky go back to their frames: a recycled cell
    // shows another item now. Removed ones take their tracks along.
    for (const [cellId, cell] of tracks) {
      if (ranges.has(cellId) && this.view(cellId) === cell) continue;
      tracks.delete(cellId);
      this.unstick(cell);
    }
    for (const [cellId, range] of ranges) {
      const cell = this.view(cellId);
      if (!cell) continue;
      if (!cell._track) {
        // A frame update earlier in this batch may have started an animation
        // in content coordinates. Sticky positioning uses insets in the track.
        cell._frameAnimation?.cancel();
        cell._frameAnimation = null;
        const track = document.createElement("div");
        track.className = "nsh-track";
        track._list = el;
        // Where the list's cells are: in it, or in its content layer; the
        // cells of a list in the scroll view's viewport are in that list,
        // which keeps their z-index to itself.
        const own = el._layer ?? el;
        const host = cell.parentNode ?? own;
        track._page = host !== own;
        if (track._page) host.classList.add("nsh-sticky");
        host.insertBefore(track, cell.parentNode === host ? cell : null);
        track.append(cell);
        cell._track = track;
        this.readingChanged(host);
        tracks.set(cellId, cell);
      }
      cell._range = range;
      // The animated offsets come after the batch's ops (`sticky-offset`):
      // one that became a number is no longer added.
      cell._stickyOffset = undefined;
      this.placeTrack(cell);
    }
  }

  /** `cell` leaves its track for its place among the list's cells. */
  unstick(cell) {
    const track = cell._track;
    cell._track = null;
    cell._range = null;
    if (cell.parentNode === track) track.replaceWith(cell);
    else track.remove();
    this.placeFrame(cell);
    this.readingChanged(cell.parentNode);
  }

  /** Where the views around `track` (up to its scroll view) put it in the
   * scroll view's content along its axis. */
  trackOrigin(track, horizontal) {
    const list = track._list;
    let at = 0;
    for (let n = track.parentNode; n && n !== list && n !== list._layer; n = n.parentNode) {
      const f = n._frame;
      if (f) at += horizontal ? f[0] : f[1];
    }
    return at;
  }

  /** Places `cell`'s track along its range of travel and the cell in it:
   * it sticks the distance from its range's start to its frame's from the
   * scroll view's start. */
  placeTrack(cell) {
    const f = cell._frame;
    const range = cell._range;
    if (!f || !range) return;
    const list = cell._track._list;
    const horizontal = !!list._horizontal;
    const [at, size] = horizontal ? [f[0], f[2]] : [f[1], f[3]];
    // The last one's range ends past the content: it travels to its end
    // (not at all before the list's content size arrives). A page list's
    // ranges end within it, and are in the scroll view's content, where
    // the list starts at `origin`.
    const page = cell._track._page;
    const origin = page ? this.trackOrigin(cell._track, horizontal) : 0;
    const content = list._content?.[horizontal ? 0 : 1] ?? 0;
    const travel = page ? range[1] - range[0] : Math.min(range[1] - range[0], content - at - size);
    const length = size + Math.max(0, travel);
    const t = cell._track.style;
    t.left = `${f[0]}px`;
    t.top = `${f[1]}px`;
    t.width = `${horizontal ? length : 0}px`;
    t.height = `${horizontal ? 0 : length}px`;
    const s = cell.style;
    const inset = `${at + origin - range[0] + (cell._stickyOffset ?? 0)}px`;
    s.left = horizontal ? inset : "auto";
    s.top = horizontal ? "auto" : inset;
    s.width = `${f[2]}px`;
    s.height = `${f[3]}px`;
  }

  // Desktop scroll bars (the desktop idiom): nsh's own, thin, over the
  // content, shown while the view scrolls or the mouse reaches its thumb and
  // fading after, and dragged by the mouse as a scroll bar's thumb, as on
  // the desktop backends.

  /** Whether `el` has a bar: a scroll view along one axis with its
   * indicator, on either axis, unless a built-in bar of the app's takes
   * its place. */
  barShown(el) {
    return this.desktopUI && el._kind === "scroll" && !this.zooms(el) && el._behavior?.enabled !== false && !!(el._indicator && !el._replaced);
  }

  /** `el`'s thumb along its axis: `[start, length, travel, max offset]`, or null when the content fits. */
  barThumb(el) {
    const h = !!el._horizontal;
    const view = h ? el.clientWidth : el.clientHeight;
    const total = h ? el.scrollWidth : el.scrollHeight;
    // Its track keeps within the view's `scrollbarInset`.
    const [top, right, bottom, left] = this.barInset(el);
    const [before, after] = h ? [left, right] : [top, bottom];
    const room = view - before - after;
    if (total <= view + 0.5 || room <= 4 * BAR_MARGIN) return null;
    const track = room - 2 * BAR_MARGIN;
    const len = Math.min(track, Math.max(32, (track * view) / total));
    const max = total - view;
    const t = Math.min(Math.max((h ? el.scrollLeft : el.scrollTop) / max, 0), 1);
    return [before + BAR_MARGIN + t * (track - len), len, track - len, max];
  }

  /** `el`'s `scrollbarInset`: `[top, right, bottom, left]`. */
  barInset(el) {
    return el._behavior?.bar ?? [0, 0, 0, 0];
  }

  /** The edge `el`'s bar runs along (its right, or a horizontal view's bottom), moved in by its inset. */
  barEdge(el) {
    const [, right, bottom] = this.barInset(el);
    return el._horizontal ? el.clientHeight - bottom : el.clientWidth - right;
  }

  /** Shows `el`'s bar where its content is; it fades after `BAR_HOLD`
   * unless the mouse holds it. */
  showBar(el) {
    const thumb = this.barShown(el) ? this.barThumb(el) : null;
    if (!thumb) {
      if (el._bar) el._bar.firstChild.style.opacity = "0";
      return;
    }
    if (!el._bar) {
      el._bar = document.createElement("div");
      el._bar.className = "nsh-bar";
      el._bar.append(document.createElement("div"));
      el.insertBefore(el._bar, el.firstChild);
    }
    const [start, len] = thumb;
    const edge = this.barEdge(el) - BAR_THICK - BAR_MARGIN;
    el._bar.firstChild.style.cssText = el._horizontal
      ? `left:${start}px;top:${edge}px;width:${len}px;height:${BAR_THICK}px`
      : `left:${edge}px;top:${start}px;width:${BAR_THICK}px;height:${len}px`;
    clearTimeout(el._barTimer);
    if (!el._barHeld) el._barTimer = setTimeout(() => el._bar && (el._bar.firstChild.style.opacity = "0"), BAR_HOLD);
  }

  /** Whether the pointer reaches the draggable thumb, even while faded. */
  barHit(el, e) {
    if (!this.barShown(el)) return false;
    const thumb = this.barThumb(el);
    if (!thumb) return false;
    const r = el.getBoundingClientRect();
    const [x, y] = [e.clientX - r.left, e.clientY - r.top];
    const [along, across] = el._horizontal ? [x, y] : [y, x];
    const edge = this.barEdge(el);
    return across >= edge - BAR_GRAB && across <= edge && along >= thumb[0] - 4 && along <= thumb[0] + thumb[1] + 4;
  }

  /** Content hover leaves the bar and its fade timer unchanged. */
  hoverBar(el, e) {
    if (this.barHit(el, e)) this.showBar(el);
  }

  /** A mouse press on the bar of a scroll view around `e`'s target grabs
   * it, faded or not: the content moves the other way, so the thumb
   * follows the pointer. */
  grabBar(e) {
    const view = this.viewOf(e.target);
    if (!view) return false;
    for (const el of this.ancestors(view)) {
      if (!this.barHit(el, e)) continue;
      const h = !!el._horizontal;
      e.preventDefault();
      el._barHeld = true;
      // Snapping would move the content under the thumb: back once it ends.
      el.style.scrollSnapType = "none";
      this.drive(el, 1);
      this.scrollEvent(el, "onScrollDragStart");
      this.pointers.set(e.pointerId, {
        mode: "bar", scroll: el, start: h ? e.clientX : e.clientY, offset: h ? el.scrollLeft : el.scrollTop,
        touchPath: [], states: [],
      });
      this.showBar(el);
      return true;
    }
    return false;
  }

  dragBar(p, e) {
    const el = p.scroll;
    const thumb = this.barThumb(el);
    if (!thumb || thumb[2] <= 0) return;
    const d = ((el._horizontal ? e.clientX : e.clientY) - p.start) * (thumb[3] / thumb[2]);
    if (el._horizontal) el.scrollLeft = p.offset + d;
    else el.scrollTop = p.offset + d;
  }

  releaseBar(el) {
    el._barHeld = false;
    this.scrollEvent(el, "onScrollDragEnd");
    this.drive(el, -1);
    el._restoreSnap = true;
    // Snapping views settle on the nearest snap point.
    if (!el._snapPoints || !this.snapTo(el, this.snapPoint(el, 0))) {
      el._restoreSnap = false;
      el.style.scrollSnapType = "";
      this.ownEnd(el);
    }
    this.showBar(el);
  }

  scrolled(el) {
    if (el._commandEnd) this.waitCommandEnd(el);
    if (this.desktopUI) this.showBar(el);
    // Still moving after the finger left (touch scrolling is the
    // browser's): a glide.
    if (el._released && !el._momentum && performance.now() - el._released < 150) {
      el._momentum = true;
      this.scrollEvent(el, "onMomentumStart");
    }
    // Pulled to refresh, the offset is negative, as on the native backends.
    this.call((w) => w.nsh_scroll(el._id, el.scrollLeft, el.scrollTop - (el._pull ?? 0), el._applied));
  }

  /** The browser's scrolling stopped: the end, unless the scroll is driven
   * here (`drive`) or a finger still holds it. */
  scrollEnded(el) {
    // A browser wheel's scroll goes on while its events keep coming
    // (`wheelNatively`): a `scrollend` between two notches is not its end,
    // which waits for the fallback, as one scroll of nsh's ends once.
    if (el._wheelAt && performance.now() - el._wheelAt < 200) return;
    clearTimeout(el._commandEnd);
    el._commandEnd = 0;
    // A scroll animation of the core's (`animateScroll`) is driven here:
    // every frame of it sets the offset, and the `scrollend` the frame
    // before it drew is not its end. It ends on its own last frame.
    if (el._driven || el._touchDrag) return;
    // The browser's end of a scroll that ended here (`ownEnd`).
    const own = el._ownEnd;
    el._ownEnd = null;
    if (own && own[0] === el.scrollLeft && own[1] === el.scrollTop) return;
    el._released = 0;
    if (el._restoreSnap) {
      el._restoreSnap = false;
      el.style.scrollSnapType = "";
    }
    if (el._momentum) {
      el._momentum = false;
      this.scrollEvent(el, "onMomentumEnd");
    }
    this.scrollEvent(el, "onScrollEnd");
  }

  // Content layers: the children of a zoomable or refreshable scroll view
  // go into a layer that scales them (zoom) and moves them down (pull to
  // refresh); the core's frames stay the unzoomed ones.

  ensureLayer(el) {
    if (el._layer) return el._layer;
    const layer = document.createElement("div");
    layer.className = "nsh-layer";
    // Its views, and the tracks its sticky cells sit in.
    for (const child of [...el.children]) if (child._id !== undefined || child._list) layer.append(child);
    el.insertBefore(layer, el._spacer.nextSibling);
    el._layer = layer;
    el._zoom = 1;
    el._pull = 0;
    return layer;
  }

  zooms(el) {
    const b = el._behavior;
    return el._kind === "scroll" && !!b && b.maxZoom > b.minZoom;
  }

  /** Where the zoomed content starts in the scrolled area: centered while smaller than the viewport (`centerContent`). */
  layerOffset(el) {
    if (!el._behavior?.centerContent || !el._frame || !el._content) return [0, 0];
    const z = el._zoom ?? 1;
    return [Math.max(0, (el._frame[2] - el._content[0] * z) / 2), Math.max(0, (el._frame[3] - el._content[1] * z) / 2)];
  }

  /** Places the layer and sizes the scrolled area for the zoom and the pull. */
  placeLayer(el) {
    const [w, h] = el._content ?? [1, 1];
    const z = el._zoom ?? 1;
    const pull = el._pull ?? 0;
    el._spacer.style.width = `${w * z}px`;
    el._spacer.style.height = `${h * z + pull}px`;
    if (!el._layer) return;
    const [ox, oy] = this.layerOffset(el);
    el._layer.style.transform = `translate(${ox}px, ${oy + pull}px)${z !== 1 ? ` scale(${z})` : ""}`;
  }

  /** The zoom the content of `el` is shown at (its zoomable scroll views', multiplied). */
  zoomOf(el) {
    let z = 1;
    for (let e = el.parentNode; e && e !== this.root; e = e.parentNode) if (e._layer && e._zoom) z *= e._zoom;
    return z;
  }

  /** Zooms `el` to `scale` with content point (cx, cy) (unzoomed) at (fx, fy) in its viewport. */
  zoomContent(el, scale, cx, cy, fx, fy) {
    el._zoom = scale;
    this.placeLayer(el);
    const [ox, oy] = this.layerOffset(el);
    el.scrollLeft = cx * scale + ox - fx;
    el.scrollTop = cy * scale + oy - fy;
    this.call((w) => w.nsh_zoom(el._id, scale));
    this.scrolled(el);
  }

  /** The content point (unzoomed) at (fx, fy) in the viewport of `el`. */
  contentPoint(el, fx, fy) {
    const [ox, oy] = this.layerOffset(el);
    const z = el._zoom ?? 1;
    return [(el.scrollLeft + fx - ox) / z, (el.scrollTop + fy - oy) / z];
  }

  /** The zoom limits; past them by a rubber band while pinching when `bouncesZoom`. */
  limitZoom(el, scale, rubber) {
    const b = el._behavior;
    const min = b.minZoom;
    const max = Math.max(b.maxZoom, min);
    if (scale > max) return rubber && b.bouncesZoom ? max * Math.pow(scale / max, 0.3) : max;
    if (scale < min) return rubber && b.bouncesZoom ? min * Math.pow(scale / min, 0.3) : min;
    return scale;
  }

  /** Animates the zoom to `scale` with content point (cx, cy) moving to (fx, fy). */
  animateZoom(el, scale, cx, cy, fx, fy, done) {
    cancelAnimationFrame(el._zoomAnimation);
    const z0 = el._zoom;
    const [x0, y0] = this.contentPoint(el, fx, fy);
    const t0 = performance.now();
    const step = (now) => {
      const t = Math.min(1, (now - t0) / 250);
      const k = 1 - Math.pow(1 - t, 3);
      this.zoomContent(el, z0 + (scale - z0) * k, x0 + (cx - x0) * k, y0 + (cy - y0) * k, fx, fy);
      if (t < 1) el._zoomAnimation = requestAnimationFrame(step);
      else done?.();
    };
    el._zoomAnimation = requestAnimationFrame(step);
  }

  /** A zoom ended: back within the limits, and canvases drawn again at the new resolution. */
  zoomEnded(el, fx, fy) {
    const settled = () => {
      for (const canvas of el._layer?.querySelectorAll("canvas") ?? []) {
        const view = this.viewOf(canvas);
        if (view) this.drawSoon(view);
      }
    };
    const target = this.limitZoom(el, el._zoom, false);
    if (Math.abs(target - el._zoom) > 1e-3) {
      const [cx, cy] = this.contentPoint(el, fx, fy);
      this.animateZoom(el, target, cx, cy, fx, fy, settled);
    } else settled();
  }

  /** `zoomTo({ scale, x, y, animated })`: content point (x, y) to the middle of the viewport, or the point there now. */
  zoomCommand(el, scale, x, y, animated) {
    if (!this.zooms(el) || !el._frame) return;
    // Not one of the core's counted scrolls (`ScrollBy`, `ScrollTo`), as on the other platforms.
    const target = this.limitZoom(el, scale, false);
    const fx = el._frame[2] / 2;
    const fy = el._frame[3] / 2;
    const [px, py] = this.contentPoint(el, fx, fy);
    const cx = x ?? px;
    const cy = y ?? py;
    if (animated) this.animateZoom(el, target, cx, cy, fx, fy, () => this.zoomEnded(el, fx, fy));
    else {
      this.zoomContent(el, target, cx, cy, fx, fy);
      this.zoomEnded(el, fx, fy);
    }
  }

  /** Ctrl+wheel (and touchpad pinches, which browsers send as one) zooms the zoomable scroll view under the pointer; whether there was one. */
  wheelZoom(e) {
    const el = this.ancestors(this.viewOf(e.target)).find((v) => this.zooms(v) && v._behavior.pinch);
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const fx = e.clientX - r.left;
    const fy = e.clientY - r.top;
    // A mouse wheel's notches are large deltas, a touchpad pinch's small ones.
    const dy = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY;
    const factor = Math.abs(dy) >= 50 ? Math.pow(1.25, -Math.sign(dy)) : Math.exp(-dy * 0.01);
    const [cx, cy] = this.contentPoint(el, fx, fy);
    cancelAnimationFrame(el._zoomAnimation);
    this.zoomContent(el, this.limitZoom(el, el._zoom * factor, false), cx, cy, fx, fy);
    clearTimeout(el._wheelZoomTimer);
    el._wheelZoomTimer = setTimeout(() => this.zoomEnded(el, fx, fy), 200);
    return true;
  }

  /** `onPinch` of Safari's touchpad pinches (gesture events, `phase` 0 /
   * 1 / 2): the nearest view around the target that listens hears the
   * pinch from its start to its end; true when it takes it: no view that
   * pinches natively (a zoomable scroll view, `pinch` values) is nearer,
   * nor is it one (`input::wheel_listener`). Other browsers send a pinch
   * as Ctrl + wheel, which `onWheel` hears. */
  pinchEvent(e, phase) {
    let p = this.pinching;
    if (phase === 0) {
      p = this.pinching = null;
      const view = this.viewOf(e.target);
      let nearer = false;
      for (const el of view ? this.ancestors(view) : []) {
        const zooms = (this.zooms(el) && el._behavior.pinch) || !!el._gestures?.pinch;
        if (el._events?.has("onPinch")) {
          p = this.pinching = { el, takes: !nearer && !zooms, scale: 1 };
          break;
        }
        nearer ||= zooms;
      }
    }
    if (!p) return false;
    if (!p.el.isConnected) {
      this.pinching = null;
      return false;
    }
    if (p.takes) e.preventDefault();
    const r = p.el.getBoundingClientRect();
    const [pageX, pageY] = this.point(e);
    // Nothing changes at the end, as on the native backends.
    const delta = phase === 2 ? 0 : e.scale / (p.scale || 1) - 1;
    p.scale = e.scale;
    this.event(p.el._id, "onPinch", {
      position: { x: e.clientX - r.left, y: e.clientY - r.top },
      pagePosition: { x: pageX, y: pageY },
      delta,
      phase: phase === 0 ? "start" : phase === 1 ? "move" : "end",
      modifiers: { control: e.ctrlKey, alt: e.altKey, shift: e.shiftKey, platform: e.metaKey },
    });
    if (phase === 2) this.pinching = null;
    return p.takes;
  }

  /** Safari's touchpad pinches (gesture events; it sends no ctrl+wheel). */
  gestureZoom(e, phase) {
    const el = phase === 0
      ? this.ancestors(this.viewOf(e.target)).find((v) => this.zooms(v) && v._behavior.pinch)
      : this.gesture;
    if (!el) return;
    e.preventDefault();
    const r = el.getBoundingClientRect();
    const fx = (e.clientX ?? r.left + r.width / 2) - r.left;
    const fy = (e.clientY ?? r.top + r.height / 2) - r.top;
    if (phase === 0) {
      this.gesture = el;
      el._gestureStart = el._zoom;
    }
    const [cx, cy] = this.contentPoint(el, fx, fy);
    this.zoomContent(el, this.limitZoom(el, el._gestureStart * e.scale, true), cx, cy, fx, fy);
    if (phase === 2) {
      this.gesture = null;
      this.zoomEnded(el, fx, fy);
    }
  }

  // Pull to refresh (vertical scroll views with `onRefresh`, and
  // `refreshing`): dragged past the top, the content moves down over a
  // spinner; released far enough, it refreshes and keeps room for the
  // spinner until `refreshing` turns false. Only touches pull (mouse drags
  // never scroll), through touch events here (the browser scrolls them
  // otherwise).

  op_ref([, id, refreshing]) {
    const el = this.view(id);
    if (!el || el._kind !== "scroll" || el._horizontal) return;
    this.ensureLayer(el);
    el._refreshing = refreshing;
    if (!el._pulling) {
      if (refreshing && el.scrollTop <= 0.5) this.animatePull(el, this.refreshSpace(el));
      else if (!refreshing && el._pull > 0) this.animatePull(el, 0);
    }
    this.updateSpinner(el);
  }

  refreshThreshold(el) {
    return el._behavior?.refreshIndicator?.height ?? REFRESH_PULL;
  }

  refreshSpace(el) {
    return el._behavior?.refreshIndicator?.height ?? REFRESH_SPACE;
  }

  refreshable(el) {
    return el._kind === "scroll" && !el._horizontal && !this.zooms(el) && (el._events.has("onRefresh") || el._refreshing);
  }

  installPull(el) {
    this.ensureLayer(el);
    if (el._pullTouch) return;
    el._pullTouch = true;
    let start = null;
    el.addEventListener("touchstart", (e) => {
      start = e.touches.length === 1 && this.refreshable(el) && el._behavior?.enabled !== false
        ? { y: e.touches[0].clientY, v: el.scrollTop - el._pull, pulling: false }
        : null;
    }, { passive: true });
    el.addEventListener("touchmove", (e) => {
      if (!start || e.touches.length !== 1) return;
      const v = start.v - (e.touches[0].clientY - start.y);
      if (v >= 0 && el._pull <= 0) return;
      // Once the browser scrolls, the gesture is its own.
      if (!e.cancelable) {
        start = null;
        return;
      }
      e.preventDefault();
      if (!start.pulling) {
        start.pulling = true;
        el._pulling = true;
        cancelAnimationFrame(el._pullAnimation);
      }
      this.dragPull(el, v);
    }, { passive: false });
    const end = () => {
      if (start?.pulling) {
        el._pulling = false;
        this.releasePull(el);
      }
      start = null;
    };
    el.addEventListener("touchend", end);
    el.addEventListener("touchcancel", end);
  }

  /** A drag to offset `v` (negative: pulled past the top by that much). */
  dragPull(el, v) {
    if (v >= 0) {
      this.setPull(el, 0);
      el.scrollTop = v;
      return;
    }
    el.scrollTop = 0;
    const over = -v;
    // Refreshing, the spinner's room is the pull's start.
    const space = this.refreshSpace(el);
    this.setPull(el, el._refreshing ? Math.min(over, space) + Math.max(0, over - space) * 0.5 : over * 0.5);
  }

  releasePull(el) {
    if (!el._refreshing && el._events.has("onRefresh") && el._pull >= this.refreshThreshold(el)) {
      // Shown right away, as UIRefreshControl does; JS turns it off.
      el._refreshing = true;
      this.event(el._id, "onRefresh");
    }
    this.animatePull(el, el._refreshing && el._pull > 0 ? this.refreshSpace(el) : 0);
  }

  setPull(el, pull) {
    if (pull === el._pull) return;
    el._pull = pull;
    this.placeLayer(el);
    this.updateSpinner(el);
    this.scrolled(el);
    this.call((w) => w.nsh_pull(el._id, pull));
  }

  animatePull(el, target) {
    cancelAnimationFrame(el._pullAnimation);
    const from = el._pull ?? 0;
    if (from === target) return;
    const t0 = performance.now();
    const step = (now) => {
      const t = Math.min(1, (now - t0) / 250);
      this.setPull(el, from + (target - from) * (1 - Math.pow(1 - t, 3)));
      if (t < 1) el._pullAnimation = requestAnimationFrame(step);
    };
    el._pullAnimation = requestAnimationFrame(step);
  }

  /** The spinner above the content: its spokes appear as it is pulled, and turn while refreshing. */
  updateSpinner(el) {
    // Off, the app draws its own (from `pullValue`).
    const shown = el._pull > 0 && !el._behavior?.refreshIndicator;
    let spinner = el._spinner;
    if (!shown) {
      spinner?.classList.add("nsh-gone");
      return;
    }
    if (!spinner) {
      spinner = el._spinner = document.createElement("div");
      spinner.className = "nsh-spinner";
      for (let i = 0; i < 8; i++) {
        spinner.append(document.createElement("i"));
      }
      el.append(spinner);
    }
    spinner.classList.remove("nsh-gone");
    spinner.style.top = `${el._pull - this.refreshSpace(el) / 2 - 10}px`;
    const progress = el._refreshing ? 1 : Math.min(1, el._pull / this.refreshThreshold(el));
    const count = Math.min(8, Math.ceil(progress * 8));
    [...spinner.children].forEach((spoke, i) => spoke.classList.toggle("nsh-hidden", i >= count));
    // Pulled all the way, the spokes fade behind the lead one.
    spinner.classList.toggle("full", progress >= 1);
    spinner.classList.toggle("spin", !!el._refreshing);
  }


  // Canvas

  op_cv([, id, ops]) {
    const el = this.view(id);
    if (!el) return;
    el._ops = ops;
    this.drawSoon(el);
  }

  drawSoon(el) {
    if (el._drawQueued) return;
    el._drawQueued = true;
    queueMicrotask(() => {
      el._drawQueued = false;
      this.draw(el);
    });
  }

  draw(el) {
    const canvas = el._canvas;
    if (!canvas || !el._frame || !el._ops) return;
    // Zoomed in, drawn at the resolution it is shown at.
    const ratio = (devicePixelRatio || 1) * Math.min(4, this.zoomOf(el));
    const [, , w, h] = el._frame;
    const pw = Math.max(1, Math.round(w * ratio));
    const ph = Math.max(1, Math.round(h * ratio));
    if (canvas.width !== pw || canvas.height !== ph) {
      canvas.width = pw;
      canvas.height = ph;
    }
    const cx = canvas.getContext("2d");
    cx.setTransform(ratio, 0, 0, ratio, 0, 0);
    cx.clearRect(0, 0, w, h);
    this.replayCanvas(cx, el._ops, el._slots, (uri) => {
      const img = this.canvasImage(uri, el);
      // A cross-origin image without CORS taints the canvas for good
      // (the browser never clears the flag): shaders' pictures leave
      // it out (`paintTree`).
      if (img && !this.paintable(img)) canvas._tainted = true;
      return img;
    });
  }

  /**
   * Replays a drawing (`cv`'s operations, `src/canvas.rs`) onto 2D context
   * `cx`, whose transform maps points: `slots` are its animated values
   * (missing ones read 0), `image(uri)` the loaded image a `drawImage`
   * names, or none (it draws nothing).
   */
  replayCanvas(cx, ops, slots, image) {
    cx.save();
    const v = (n) => (Array.isArray(n) && n[0] === "$" ? (slots?.[n[1]] ?? 0) : n);
    const paint = (p) => {
      if (Array.isArray(p) && p[0] === "$") return slots?.[p[1]] ?? "transparent";
      if (p && typeof p === "object" && p.g) {
        const a = p.args;
        const g = p.g === "linear" ? cx.createLinearGradient(a[0], a[1], a[2], a[3])
          : p.g === "radial" ? cx.createRadialGradient(a[0], a[1], a[2], a[3], a[4], a[5])
            : cx.createConicGradient(a[0], a[1], a[2]);
        for (const [offset, color] of p.stops) g.addColorStop(Math.min(1, Math.max(0, offset)), color);
        return g;
      }
      return p;
    };
    const path = (ops) => {
      const p = new Path2D();
      for (const [name, ...args] of ops) {
        if (name === "roundRect") p.roundRect(...args.slice(0, 4).map(v), args[4].map(v));
        else p[name](...args.map(v));
      }
      return p;
    };
    for (const [name, ...args] of ops) {
      try {
        if (name.startsWith("=")) {
          const prop = name.slice(1);
          cx[prop] = prop.endsWith("Style") ? paint(args[0]) : v(args[0]);
        } else if (name === "fill" || name === "clip") {
          if (args[0]) cx[name](path(args[0]), args[1]);
          else cx[name](args[1]);
        } else if (name === "stroke") {
          if (args[0]) cx.stroke(path(args[0]));
          else cx.stroke();
        } else if (name === "shadowOffset") {
          cx.shadowOffsetX = args[0];
          cx.shadowOffsetY = args[1];
        } else if (name === "roundRect") {
          cx.roundRect(...args.slice(0, 4).map(v), args[4].map(v));
        } else if (name === "drawImage") {
          const img = image(args[0]);
          if (!img) continue;
          // The source in the image's pixels; a missing destination size
          // is the source's over the file name's density (`@3x`), as an
          // `Image`'s, never the screen's (`CanvasImage::density`).
          const [sx, sy, sw, sh] = args[1] ?? [0, 0, img.naturalWidth || img.width, img.naturalHeight || img.height];
          const [dx, dy, dw, dh] = args.slice(2).map(v);
          const density = imageDensity(args[0]);
          cx.drawImage(
            img, sx, sy, sw, sh, dx, dy,
            Number.isFinite(dw) ? dw : sw / density,
            Number.isFinite(dh) ? dh : sh / density,
          );
        } else if (name === "fillText" || name === "strokeText") {
          cx[name](args[0], ...args.slice(1).map(v));
        } else if (name === "setLineDash") {
          cx.setLineDash(args[0]);
        } else if (typeof cx[name] === "function") {
          cx[name](...args.map(v));
        }
      } catch (err) {
        console.warn("[nsh] canvas", name, err);
      }
    }
    cx.restore();
  }

  /**
   * `OffscreenCanvas.convertToBlob` (`Command::RenderCanvas`): the drawing
   * replayed as `draw` replays a canvas view's, into a transparent
   * `width` × `height` pixel canvas of its own at `scale` pixels per point,
   * its animated values at 0, once the images it names have loaded (a
   * failed one draws nothing), and encoded as `type`. The bytes, or why
   * there are none, go to the engine (`nsh_canvas_image`, with a
   * `CANVAS_IMAGE` status): a canvas over the browser's size limit
   * (`offscreenCanvas`) answers `TOO_LARGE`, which the app gets as
   * `ERR_NSH_QUOTA_EXCEEDED`.
   */
  async renderCanvas(request, ops, width, height, scale, type) {
    const app = this.app;
    let status = CANVAS_IMAGE.OK;
    let bytes;
    try {
      const uris = [...new Set(ops.filter(([name]) => name === "drawImage").map(([, uri]) => uri))];
      const images = new Map(await Promise.all(uris.map(async (uri) => [uri, await this.offscreenImage(uri)])));
      const { canvas, cx } = this.offscreenCanvas(width, height);
      cx.setTransform(scale, 0, 0, scale, 0, 0);
      this.replayCanvas(cx, ops, null, (uri) => images.get(uri));
      let blob;
      try {
        blob = canvas.convertToBlob
          ? await canvas.convertToBlob({ type })
          : await new Promise((resolve) => canvas.toBlob(resolve, type));
      } catch (err) {
        // A size the canvas took but the encoder has no memory for.
        if (err?.name === "RangeError" || err?.name === "IndexSizeError") throw new CanvasTooLarge(tooLarge(width, height));
        throw err;
      }
      // `toBlob` hands no error, only nothing, when the bitmap is too large to encode.
      if (!blob) throw new CanvasTooLarge(tooLarge(width, height));
      bytes = new Uint8Array(await blob.arrayBuffer());
    } catch (err) {
      status = err instanceof CanvasTooLarge ? CANVAS_IMAGE.TOO_LARGE : CANVAS_IMAGE.FAILED;
      bytes = String(err?.message ?? err);
    }
    if (app !== this.app) return;
    this.call((w) => this.withStrings([bytes], (p, l) => w.nsh_canvas_image(request, status, p, l)));
  }

  /**
   * A `width` × `height` pixel canvas and its 2D context for an offscreen
   * render, or a `CanvasTooLarge` when the browser cannot make one that size.
   * Past their limits (iOS WebKit's is 16777216 pixels in all; Chromium's and
   * Firefox's are larger than the core's own) browsers make no context,
   * throw, or make a canvas that silently draws nothing, so one opaque pixel
   * is drawn in the far corner and read back before the drawing: a canvas
   * that kept it holds every pixel. Sizes that failed are remembered
   * (`tooLargeCanvases`): any size at least as large in both sides fails
   * again without allocating.
   */
  offscreenCanvas(width, height) {
    const known = (this.tooLargeCanvases ??= []);
    if (known.some(([w, h]) => width >= w && height >= h)) throw new CanvasTooLarge(tooLarge(width, height));
    const fail = () => {
      known.push([width, height]);
      if (known.length > 8) known.shift();
      return new CanvasTooLarge(tooLarge(width, height));
    };
    let canvas;
    let cx;
    try {
      canvas = typeof OffscreenCanvas !== "undefined"
        ? new OffscreenCanvas(width, height)
        : Object.assign(document.createElement("canvas"), { width, height });
      cx = canvas.getContext("2d");
    } catch {
      throw fail();
    }
    if (!cx) throw fail();
    const x = width - 1;
    const y = height - 1;
    let kept;
    try {
      cx.fillRect(x, y, 1, 1);
      kept = cx.getImageData(x, y, 1, 1).data[3] === 255;
      cx.clearRect(x, y, 1, 1);
    } catch {
      kept = false;
    }
    if (!kept) throw fail();
    return { canvas, cx };
  }

  /**
   * The image at `uri` for an offscreen render, loaded (null when it fails):
   * one that would taint the canvas (another origin's without CORS) is
   * asked for again with CORS, so the image can still be read back. One that
   * fails is skipped with a warning, as every platform skips it; when it
   * loads without CORS but not with it, the warning says that its server
   * sends no CORS headers.
   */
  offscreenImage(uri) {
    const src = this.asset(uri);
    const cached = this.images.get(src);
    if (cached?.ready && this.paintable(cached.img)) return Promise.resolve(cached.img);
    const load = (cors) => new Promise((resolve) => {
      const img = new Image();
      if (cors) img.crossOrigin = "anonymous";
      img.onload = () => resolve(img);
      img.onerror = () => resolve(null);
      img.src = src;
    });
    const cors = !/^(data|blob):/.test(src) && !sameOrigin(src);
    return load(cors).then(async (img) => {
      if (img) return img;
      if (cors && await load(false)) {
        console.warn(`[nsh] offscreen canvas: ${uri} is skipped: its server (${originOf(src)}) sends no CORS headers (Access-Control-Allow-Origin), so the page cannot read it back; on the web, images come from the page's origin or servers that allow CORS`);
      } else {
        console.warn(`[nsh] offscreen canvas: ${uri} could not be loaded and is skipped`);
      }
      return null;
    });
  }

  canvasImage(uri, el) {
    const src = this.asset(uri);
    let entry = this.images.get(src);
    if (!entry) {
      const img = new Image();
      entry = { img, ready: false, waiting: new Set() };
      img.onload = () => {
        entry.ready = true;
        for (const w of entry.waiting) this.drawSoon(w);
      };
      this.setImageSource(img, uri, src);
      this.images.set(src, entry);
    }
    if (!entry.ready) entry.waiting.add(el);
    return entry.ready ? entry.img : null;
  }

  // Gestures

  op_g([, id, pan, pinch, rotation]) {
    const el = this.view(id);
    if (!el) return;
    el._gestures = { pan, pinch, rotation };
    this.updateTouchAction(el);
  }

  // Inputs

  /** A field; `css` is the class of its text (font, color, alignment,
   * line height, placeholder and caret colors). */
  op_in([, id, config, css]) {
    const el = this.view(id);
    if (!el) return;
    let field = el._field;
    const tag = config.multiline ? "TEXTAREA" : "INPUT";
    if (!field || field.tagName !== tag) {
      field?.remove();
      field = document.createElement(tag);
      field.className = "nsh-field";
      field._count = 0;
      // The text last reported or set: an `input` event that leaves it
      // (a composition's end in Safari, after the text it committed was
      // reported) reports nothing.
      field._known = "";
      this.wireInput(el, field);
      el._field = field;
      el.append(field);
      if (el._content) this.placeContent(el);
      else this.fieldStop(el);
    }
    swapClass(field, "_class", this.styleClass(css));
    this.fieldAria(el, field);
    // Filling the view, or placed at its content's frame (`placeContent`).
    field.classList.toggle("nsh-inset", !el._content);
    field.placeholder = config.placeholder;
    if (!config.multiline) {
      field.type = config.secure ? "password"
        : config.keyboard === "email-address" ? "email"
          : config.keyboard === "url" ? "url"
            : config.keyboard === "phone-pad" ? "tel" : "text";
      field.inputMode = { "number-pad": "numeric", numeric: "decimal", "decimal-pad": "decimal", "numbers-and-punctuation": "text", "phone-pad": "tel", "email-address": "email", url: "url" }[config.keyboard] ?? "text";
    }
    // A textarea that submits shows the return key's action too.
    if (!config.multiline || config.submit !== "newline") {
      field.enterKeyHint = { done: "done", go: "go", next: "next", search: "search", send: "send" }[config.returnKey] ?? "enter";
    } else field.removeAttribute("enterkeyhint");
    field.readOnly = !config.editable;
    // A password shown as plain text (a password field that is not secure)
    // is never capitalized or checked (the closest the browser has to
    // Android's visible password keyboard).
    const password = !config.secure && (config.autoComplete === "current-password" || config.autoComplete === "new-password");
    const correct = config.autoCorrect && !password;
    field.autocapitalize = password || config.autoCapitalize === "none" ? "off" : config.autoCapitalize;
    field.spellcheck = correct;
    // `spellcheck` alone only stops suggestions: Chrome on Android still asks
    // the keyboard to autocorrect unless this attribute is off.
    field.setAttribute("autocorrect", correct ? "on" : "off");
    if (config.autoComplete != null) field.setAttribute("autocomplete", config.autoComplete);
    else field.removeAttribute("autocomplete");
    field._maxLength = config.maxLength ?? null;
    this.fieldLimit(field);
    el._config = config;
    field.classList.toggle("nsh-ph", !!config.placeholderColor);
    // A built-in bar of the app's takes the textarea's indicator's place.
    field.classList.toggle("nsh-noindicator", !!config.noIndicator);
    this.inputScrolled(el, field);
    if (config.autoFocus && !el._autoFocused) {
      el._autoFocused = true;
      // Focused once the batch has put it in the page (`focusAppeared`).
      (this.autoFocusing ??= new Set()).add(el);
    }
  }

  wireInput(el, field) {
    field.addEventListener("beforeinput", (e) => this.beforeInput(field, e));
    field.addEventListener("input", () => this.textChanged(el, field));
    field.addEventListener("scroll", () => this.inputScrolled(el, field), { passive: true });
    if (typeof ResizeObserver === "function") {
      new ResizeObserver(() => this.inputScrolled(el, field)).observe(field);
    }
    // An input method's composition: the app's value is held while it
    // lasts (`op_iv`), since setting a field's value ends the composition
    // and commits its text as typed (pinyin letters instead of the
    // characters chosen).
    field.addEventListener("compositionstart", (e) => {
      field._composing = true;
      this.fieldLimit(field);
      this.compositionChanged(el, field, e.data ?? "");
    });
    field.addEventListener("compositionupdate", (e) => this.compositionChanged(el, field, e.data ?? ""));
    field.addEventListener("compositionend", () => {
      field._composing = false;
      // The committed text is reported before the end (browsers differ in
      // whether its `input` event comes before or after).
      this.textChanged(el, field);
      this.compositionChanged(el, field, "");
      const pending = field._pending;
      field._pending = null;
      if (pending) this.op_iv([, el._id, ...pending]);
    });
    field.addEventListener("keydown", (e) => {
      // A key a shortcut takes (`keyDown`, after this) is the shortcut's
      // alone, as on the native platforms, where the field never sees it: a
      // RichEditor would delete twice on Backspace, and a Return an
      // autocomplete list binds would submit the field as well.
      const taken = consumedShortcut(this.shortcut(e, true));
      if (el._events.has("onKeyPress") && !taken) {
        const key = e.key === "Backspace" || e.key === "Enter" || e.key === "Escape" || e.key?.length === 1 ? e.key : null;
        if (key) this.event(el._id, "onKeyPress", { key });
      }
      // Return submits unless it inserts a line break (`submitBehavior`);
      // Shift / Alt+Return always do in a textarea, and a return that
      // commits an input method's composition never submits.
      const submit = el._config?.submit ?? "blurAndSubmit";
      const lineBreak = field.tagName === "TEXTAREA" && (submit === "newline" || e.shiftKey || e.altKey);
      if (e.key === "Enter" && !lineBreak && !e.isComposing && e.keyCode !== 229 && !taken) {
        e.preventDefault();
        this.event(el._id, "onSubmitEditing", { text: field.value, count: field._count });
        if (submit === "blurAndSubmit") field.blur();
      }
    });
    // `selectTextOnFocus`: focus selects the whole text, however it comes. A
    // press that focuses the field places the caret after the focus (on
    // its mousedown or its mouseup, by browser), so the press's mouseup
    // selects it again unless the press made its own selection: a drag's
    // range, a Shift-click's extension, or a second click on the focused
    // field (a double click's word).
    field.addEventListener("pointerdown", (e) => {
      if (document.activeElement === field) field._selectOnUp = false;
      else field._shiftPress = e.shiftKey;
    });
    const pressEnded = () => { field._shiftPress = false; };
    field.addEventListener("pointerup", pressEnded);
    field.addEventListener("pointercancel", pressEnded);
    field.addEventListener("mouseup", (e) => {
      if (!field._selectOnUp) return;
      field._selectOnUp = false;
      if (field.selectionStart !== field.selectionEnd) return;
      e.preventDefault();
      field.setSelectionRange(0, field.value.length);
      this.selectionChanged(el, field);
    });
    field.addEventListener("focus", () => {
      this.setState(el, FOCUSED, true);
      this.event(el._id, "onFocus");
      if (el._config?.selectTextOnFocus && !field._shiftPress) {
        field.setSelectionRange(0, field.value.length);
        field._selectOnUp = true;
        this.selectionChanged(el, field);
      }
    });
    field.addEventListener("blur", () => {
      field._selectOnUp = false;
      this.setState(el, FOCUSED, false);
      this.event(el._id, "onBlur");
    });
    field.addEventListener("select", () => this.selectionChanged(el, field));
    field.addEventListener("keyup", () => this.selectionChanged(el, field));
    field.addEventListener("pointerup", () => this.selectionChanged(el, field));
    // Scrolling the text moves the caret.
    field.addEventListener("scroll", () => this.caretMoved(el, field));
    field.addEventListener("paste", (e) => this.pasted(el, e));
  }

  /** Reports how far `el`'s textarea scrolled, and its text's height and
   * its viewport's, while a bar of the app's follows it (`reportScroll`). */
  inputScrolled(el, field) {
    if (!el._config?.reportScroll || field.tagName !== "TEXTAREA") return;
    const now = [field.scrollTop, field.clientWidth, field.scrollHeight, field.clientHeight];
    if (field._scrolled?.every((v, i) => v === now[i])) return;
    field._scrolled = now;
    this.call((w) => w.nsh_input_scroll(el._id, ...now));
  }

  /** `field`'s `maxlength` for its `maxLength`: the browser counts UTF-16
   * units, `maxLength` characters ({@link charLength}), so the limit is the
   * units the text has plus one per character of room left, set again
   * after each edit. An input method's composition, whose text the page
   * cannot cut, stays within `maxLength` characters that way: a character
   * of one unit leaves the limit as it was, one of two (an emoji) raises it
   * by one. */
  fieldLimit(field) {
    const max = field._maxLength;
    if (max == null) {
      field.removeAttribute("maxlength");
      return;
    }
    const value = field.value;
    field.maxLength = value.length + Math.max(0, max - charLength(value));
  }

  /** Before the user's insertion of known text (typing, a paste, a drop, the
   * app's `insertText`) into `field`: its `maxlength` takes exactly what of
   * that text fits by characters ({@link clipChars}), so the browser cuts
   * it there itself, keeping its own undo. */
  beforeInput(field, e) {
    const max = field._maxLength;
    if (max == null || !e.inputType?.startsWith("insert")) return;
    const text = e.inputType === "insertCompositionText" ? null : e.data ?? e.dataTransfer?.getData("text/plain") ?? null;
    if (text == null) {
      this.fieldLimit(field);
      return;
    }
    const value = field.value;
    const start = field.selectionStart ?? value.length;
    const end = field.selectionEnd ?? start;
    const kept = value.slice(0, start) + value.slice(end);
    field.maxLength = kept.length + clipChars(text, max - charLength(kept)).length;
  }

  textChanged(el, field) {
    this.fieldLimit(field);
    this.inputScrolled(el, field);
    if (field.value === field._known) return;
    field._known = field.value;
    field._count++;
    this.event(el._id, "onChangeText", { text: field.value, count: field._count });
  }

  compositionChanged(el, field, text) {
    const composing = !!field._composing;
    const last = field._composition;
    if (last && last[0] === composing && last[1] === text) return;
    field._composition = [composing, text];
    if (el._events.has("onCompositionChange")) this.event(el._id, "onCompositionChange", { composing, text });
  }

  selectionChanged(el, field) {
    this.caretMoved(el, field);
    if (!el._events.has("onSelectionChange")) return;
    const sel = [field.selectionStart ?? 0, field.selectionEnd ?? 0];
    if (el._selection && el._selection[0] === sel[0] && el._selection[1] === sel[1]) return;
    el._selection = sel;
    this.event(el._id, "onSelectionChange", { start: sel[0], end: sel[1] });
  }

  /** A paste into a field: what the clipboard holds (`onPaste`, the files'
   * bytes handed to WebAssembly as they are), and the field's own paste
   * of the text unless `pasteBehavior` is `"report"`. The browser gives the
   * clipboard only to this event, the user's paste. */
  pasted(el, e) {
    if (el._config?.pasteInserts === false) e.preventDefault();
    if (!el._events.has("onPaste")) return;
    const data = e.clipboardData;
    const text = data?.getData("text/plain") ?? "";
    const html = data?.getData("text/html") ?? "";
    const files = [...(data?.files ?? [])];
    // A file manager's files are local paths the page cannot read: their
    // `file:` URLs, when the browser lists them.
    const uris = (data?.getData("text/uri-list") ?? "").split(/\r?\n/).filter((u) => u.startsWith("file:"));
    Promise.all(files.map((f) => f.arrayBuffer())).then((buffers) => {
      const size = buffers.reduce((n, b) => n + b.byteLength, 0);
      const bytes = new Uint8Array(size);
      let at = 0;
      for (const b of buffers) {
        bytes.set(new Uint8Array(b), at);
        at += b.byteLength;
      }
      const json = JSON.stringify({
        text,
        html,
        files: files.map((f, i) => ({ name: f.name || "image.png", type: f.type, size: buffers[i].byteLength })),
        uris,
      });
      this.call(() => this.withStrings([json, bytes], (jp, jl, bp, bl) => this.wasm.nsh_paste(el._id, jp, jl, bp, bl)));
    });
  }

  /** `onCaretMove` while the field has the focus, if its caret moved. */
  caretMoved(el, field) {
    if (!el._events.has("onCaretMove") || document.activeElement !== field) return;
    const caret = this.caretBounds(el, field);
    const key = caret.join();
    if (el._caret === key) return;
    el._caret = key;
    const [x, y, width, height] = caret;
    this.event(el._id, "onCaretMove", { bounds: { origin: { x, y }, size: { width, height } } });
  }

  /** The caret at the selection's end in view `el` (`[x, y, width,
   * height]`): a field tells no caret's place, so a hidden copy of it
   * (its font, box and wrapping) holds the text up to the caret and a
   * marker where the caret is, as libraries for textarea carets do. */
  caretBounds(el, field) {
    const style = getComputedStyle(field);
    const area = field.tagName === "TEXTAREA";
    const mirror = this._caretMirror ??= document.createElement("div");
    const m = mirror.style;
    for (const p of CARET_STYLE) m[p] = style[p];
    m.position = "absolute";
    m.visibility = "hidden";
    m.top = "0";
    m.left = "-9999px";
    m.overflow = "hidden";
    m.whiteSpace = area ? "pre-wrap" : "pre";
    m.overflowWrap = area ? "break-word" : "normal";
    document.body.appendChild(mirror);
    const end = field.selectionEnd ?? field.value.length;
    const before = field.value.slice(0, end);
    mirror.textContent = field.type === "password" ? "•".repeat(before.length) : before;
    const marker = document.createElement("span");
    // Something to measure, even at the end of the text.
    marker.textContent = field.value.slice(end) || ".";
    mirror.appendChild(marker);
    const fontSize = parseFloat(style.fontSize) || 16;
    const height = parseFloat(style.lineHeight) || fontSize * 1.2;
    const border = (side) => parseFloat(style[`border${side}Width`]) || 0;
    let x = marker.offsetLeft + border("Left") - field.scrollLeft;
    // A single line is centered in its box.
    let y = area
      ? marker.offsetTop + border("Top") - field.scrollTop
      : (field.clientHeight - height) / 2 + border("Top");
    mirror.remove();
    x += field.offsetLeft;
    y += field.offsetTop;
    return [x, y, 1, height];
  }

  op_iv([, id, text, count]) {
    const field = this.view(id)?._field;
    if (!field || count < field._count) return;
    if (field._composing) {
      field._pending = [text, count];
      return;
    }
    field._known = text;
    if (field.value !== text) {
      // The app's value is never cut to `maxLength`, as on every platform
      // (the browser's `maxlength` limits only the user's edits).
      field.value = text;
      this.fieldLimit(field);
    }
  }

  op_ic([, id, x, y, w, h]) {
    const el = this.view(id);
    if (!el) return;
    el._content = [x, y, w, h];
    this.placeContent(el);
  }

  placeContent(el) {
    const field = el._field;
    if (!field || !el._content) return;
    const [x, y, w, h] = el._content;
    field.classList.remove("nsh-inset");
    field.style.left = `${x}px`;
    field.style.top = `${y}px`;
    field.style.width = `${w}px`;
    field.style.height = `${h}px`;
    this.fieldStop(el);
    // Its text may wrap elsewhere now.
    this.caretMoved(el, field);
  }

  // Navigation

  op_scr([, id, height, preventBack, header, animation]) {
    const el = this.view(id);
    if (!el) return;
    el._screen = { height, preventBack, header, animation };
    this.placeHeader(el);
    const stack = el.parentNode;
    if (stack?._kind === "stack" && stack._frame) this.reportRoot(el, stack._frame[2], stack._frame[3], this.screenInsets(el));
  }

  /** Puts screen `screen`'s `header` (the app's view, which the core
   * places at its top) in it, above its content; NSH draws no header. */
  placeHeader(screen) {
    const id = screen._screen?.header;
    const header = id != null ? this.view(id) : null;
    if (screen._header && screen._header !== header) screen._header.remove();
    screen._header = header;
    if (!header) return;
    header.classList.add("nsh-page-header");
    if (header.parentNode !== screen) screen.append(header);
  }

  /** The insets of screen `screen`'s content: the page's safe area, but
   * the top's when its `header` covers it. */
  screenInsets(screen) {
    const safe = this.safeProbe ? this.safeArea() : [0, 0, 0, 0];
    return screen._screen?.header != null ? [0, safe[1], safe[2], safe[3]] : safe;
  }

  /** Back on screen `screen`: `onBackPress` when the app listens, then
   * it pops unless `popOnBack` is false. */
  goBack(screen) {
    if (screen._events?.has("onBackRequest")) this.event(screen._id, "onBackRequest");
    if (screen._screen?.preventBack) return;
    const stack = screen.parentNode;
    const screens = stack ? [...stack.children].filter((s) => s._kind === "screen") : [];
    const below = screens[screens.indexOf(screen) - 1];
    if (below) {
      clearTimeout(stack._hideTimer);
      below.classList.remove("nsh-hidden");
      below.style.transform = "";
    }
    stack._top = below ?? null;
    screen._popping = true;
    // The screen goes, then the app is told (and removes it); an address
    // the browser's back moved waits for the app's answer (`settlePop`).
    this.dismissing = (this.dismissing ?? 0) + 1;
    const dismissed = () => {
      this.dismissing -= 1;
      this.event(screen._id, "onDismiss");
      if (this.popAnswer) setTimeout(() => this.settlePop(), 0);
    };
    // Through its shader, with its own motion, or at once.
    this.moveScreens(screen, below, false, dismissed);
    this.syncHistorySoon();
  }

  /** A stack's screens, without one going back. */
  screensOf(stack) {
    return [...stack.children].filter((s) => s._kind === "screen" && !s._popping && !s._removedFrom);
  }

  /** How screen `screen` comes and goes: `{ duration, fade }`, or null
   * for at once (the Linux backend's motion). */
  screenMotion(screen) {
    const animation = screen?._screen?.animation ?? "default";
    if (animation === "none") return null;
    if (animation === "fade" || this.reduceMotion()) return { duration: FADE_MS, fade: true };
    return { duration: SLIDE_MS, fade: false };
  }

  /** Animates a stack's top screen changing from `old` to `top`:
   * pushed (`pushing`) or popped. Calls `done` when the motion ends. */
  moveScreens(old, top, pushing, done) {
    // Through the page's `transitionShader`: the page below is its lower
    // side, the page above its upper one.
    const upper = pushing ? top : old;
    const stack = (top ?? old)?.parentNode;
    this.endNavShader(stack);
    if (upper?._navShader && stack) {
      if (!pushing) old.style.pointerEvents = "none";
      if (this.shaderNav(stack, upper, upper._navShader, !pushing, done)) return;
    }
    const motion = this.screenMotion(pushing ? top : old);
    if (!motion) {
      // At once: the screen that leaves shows no more.
      if (!pushing && old) old.style.visibility = "hidden";
      done?.();
      return;
    }
    const options = { duration: motion.duration, easing: EASE_OUT_CUBIC };
    const shift = (from, to) => [{ transform: `translateX(${from}%)` }, { transform: `translateX(${to}%)` }];
    const parallax = -PARALLAX * 100;
    let a;
    if (pushing) {
      a = top.animate(motion.fade ? [{ opacity: 0 }, { opacity: 1 }] : shift(100, 0), options);
      if (!motion.fade && old) {
        old.animate(shift(0, parallax), options);
        old.style.transform = `translateX(${parallax}%)`;
      }
    } else {
      a = old.animate(motion.fade ? [{ opacity: 1 }, { opacity: 0 }] : shift(0, 100), { ...options, fill: "forwards" });
      old.style.pointerEvents = "none";
      if (!motion.fade && top) top.animate(shift(parallax, 0), options);
    }
    if (!done) return;
    // Web Animations finish as the page renders, which stops with its
    // frames (a hidden tab): a timer ends the change on time without them.
    let finish = () => {
      finish = null;
      clearTimeout(timer);
      done();
    };
    const timer = setTimeout(() => finish?.(), motion.duration + LATE_MS);
    a.onfinish = () => finish?.();
  }

  /** The batch is applied: the stacks it changed animate to their new top
   * screen, and screens removed from them leave (the top one animating out). */
  reconcileStacks() {
    const stacks = this.changedStacks;
    this.changedStacks = new Set();
    for (const stack of stacks) {
      const screens = this.screensOf(stack);
      const top = screens[screens.length - 1] ?? null;
      const old = stack._top ?? null;
      const shown = stack._shown ?? [];
      stack._top = top;
      stack._shown = screens;
      const removed = old?._removedFrom === stack;
      let leaving = null;
      if (old && top && old !== top && stack._frame?.[2] > 0) {
        if (!shown.includes(top)) {
          this.moveScreens(removed ? null : old, top, true);
        } else if (removed && !old._popping) {
          // Popped by the app: it slides out, then leaves.
          leaving = old;
          old._popping = true;
          this.moveScreens(old, top, false, () => {
            old._popping = false;
            old.style.pointerEvents = "";
            if (old._removedFrom === stack) {
              old._removedFrom = null;
              old.remove();
              this.dropLeftWith(old);
            }
          });
        }
      }
      for (const screen of [...stack.children]) {
        if (screen._removedFrom === stack && screen !== leaving) {
          screen._removedFrom = null;
          screen._popping = false;
          screen.remove();
          this.dropLeftWith(screen);
        }
      }
    }
  }


  /** The newest modal that is presented and not leaving. */
  topModal() {
    const modals = [...this.root.children].filter((el) => el._kind === "modal" && !el._leaving);
    return modals[modals.length - 1] ?? null;
  }

  /** Whether stack `el` shows: in the tree, visible, and laid out with a
   * size, as the views around it. `display: none` (a tab not selected) is
   * laid out by the core at zero size, which the browser's
   * `checkVisibility` does not see. */
  stackShown(el) {
    if (!el.isConnected || !(el.checkVisibility?.({ visibilityProperty: true }) ?? true)) return false;
    // It and the views around it: a page of a stack laid out at no size is
    // laid out at its stack's.
    for (let view = el; view && view !== this.root; view = view.parentElement) {
      const frame = view._frame;
      if (frame && !(frame[2] > 0 && frame[3] > 0)) return false;
    }
    return true;
  }

  /** The innermost shown stack (inside `within`, else anywhere) that goes
   * back: it has a screen under the top one, or a top one that asks. */
  backStack(within) {
    const candidates = [];
    for (const el of this.views.values()) {
      if (el._kind !== "stack" || !this.stackShown(el) || (within && !within.contains(el))) continue;
      const screens = this.screensOf(el);
      if (screens.length > 1 || screens[screens.length - 1]?._screen?.preventBack) candidates.push(el);
    }
    return candidates.find((c) => !candidates.some((o) => o !== c && c.contains(o))) ?? null;
  }

  /**
   * Going back (Escape, the browser's or the mouse's back button): a stack
   * inside the newest modal pops, else that modal asks to close; without a
   * modal the app's `onBackPress` hears it first when it listens (it sends
   * `Command::Back` when no listener takes it), else the innermost stack
   * pops. Decided here from what is mounted, as on Android and desktops.
   * Whether something took it.
   */
  back() {
    if (!this.topModal() && this.root._events?.has("onBackPress")) {
      this.event(ROOT_ID, "onBackPress");
      return true;
    }
    return this.defaultBack();
  }

  /** Going back as without the app's listeners (`Command::Back`). */
  defaultBack() {
    const modal = this.topModal();
    const stack = this.backStack(modal);
    if (stack) {
      const screens = this.screensOf(stack);
      this.goBack(screens[screens.length - 1]);
      return true;
    }
    if (modal) {
      this.requestClose(modal);
      return true;
    }
    return false;
  }

  // History: one entry per screen over the bottom one of each shown stack
  // and per presented modal, so that the browser's back button goes back
  // in the app. Entries the app takes away itself are gone back over
  // (`history.go`), their `popstate` ignored. Each entry has its depth
  // (`nsh`) and its place among this load's entries (`nshIndex`): an
  // address the user typed is an entry at the depth it was typed at, and
  // a back or forward between entries of one depth moves the app's
  // address (`change`).

  installHistory() {
    this.historyDepth = 0;
    this.ignoredPops = 0;
    // Entries are this page load's: those of an earlier load (a reload
    // keeps them, with their depths) are foreign, below this one's.
    this.historySession = newHistorySession();
    // The current entry's place, and the depth of each entry up to the
    // newest (what a back of the app's own goes back over), and the address
    // each had when the player last wrote it or was on it (what
    // `takeOverEntry` checks the entry under against).
    this.historyIndex = 0;
    this.historyDepths = [0];
    this.historyUrls = [location.href];
    history.replaceState(this.historyState(0), "");
    // The app's first entry's place in the tab's history, where the
    // browser says (`navigationIndex`): a state-less entry before it is the
    // page's own, from before the player, not an address the user typed.
    this.historyBase = navigationIndex();
    // The address of the app's first entry, where every run starts, and of
    // the entry shown (a page the app keeps on a back keeps it).
    this.firstUrl = this.shownUrl = location.href;
    window.addEventListener("popstate", (e) => this.popState(e));
  }

  /** Whether the entry the user went to is before the app's first: the
   * page's own (a `#fragment` followed while the app loaded, a `pushState`
   * of the host page's), which looks to `popstate` like an address the user
   * typed. Only the Navigation API tells them apart; without it a
   * state-less entry is taken as typed. */
  beforeFirstEntry() {
    const index = navigationIndex();
    return index != null && this.historyBase != null && index < this.historyBase;
  }

  historyState(depth, index = this.historyIndex) {
    return { ...(history.state ?? {}), nsh: depth, nshSession: this.historySession, nshIndex: index };
  }

  /** A new run starts at the app's first entry. */
  resetHistory() {
    if (!this.history) return;
    this.pageUrl = null;
    this.pageUrlPush = false;
    this.endPopAnswer();
    const index = this.historyIndex;
    this.historyIndex = 0;
    this.historyDepths = [0];
    this.historyUrls.length = 1;
    this.historyDepth = 0;
    if (!index) return;
    this.ignoredPops++;
    history.go(-index);
  }

  /** A new entry after the current one, at `depth`, with address `url`
   * (the current one's when not given): those after it go. */
  pushEntry(depth, url) {
    const index = this.historyIndex + 1;
    history.pushState(this.historyState(depth, index), "", url);
    this.historyDepths.length = index;
    this.historyDepths.push(depth);
    this.historyUrls.length = index;
    this.historyUrls.push(location.href);
    this.historyIndex = index;
  }

  /** The newest entry before the current one at most `depth` deep: where
   * a back of the app's own to `depth` goes. */
  entryAtDepth(depth) {
    for (let i = this.historyIndex - 1; i > 0; i--) if (this.historyDepths[i] <= depth) return i;
    return 0;
  }

  /** A link's `href` under the site's base, as a `<base href>` would have
   * it (the page's own address is one of the app's routes). */
  linkHref(href) {
    try {
      return new URL(String(href), this.siteBase).href;
    } catch {
      return String(href);
    }
  }

  /** What the app's relative addresses and links resolve against: the
   * site's base (`baseURL`), else the page's current base, as
   * `history.replaceState` resolves them. */
  addressBase() {
    return this.siteBase ?? document.baseURI;
  }

  /** `UrlScheme.setUrl` / `set_app_url`: the current entry's address, once
   * the entries of the pages pushed or popped with it exist
   * (`syncHistory`); with `push` (`history: "push"`) an entry of its own
   * after it, unless the turn pushed a page's (which takes the address) or
   * it is the address shown. In one turn the last address wins, and a push
   * wins over a replace. Resolved against `addressBase()`; one of another
   * origin is dropped (TS's `setUrl` throws for it first, in `runtime.js`). */
  setPageUrl(url, push = false) {
    if (!this.history) return;
    let resolved;
    try {
      resolved = new URL(url, this.addressBase());
    } catch {
      console.warn(`[nsh] the app's address is not a URL: ${url}`);
      return;
    }
    if (resolved.origin !== location.origin) {
      console.warn(`[nsh] the app's address is not of the page's origin: ${resolved.href}`);
      return;
    }
    this.pageUrl = resolved.href;
    if (push && this.earlyPushed) {
      // An entry of its own was written for this task's push already
      // (`pushEarly`): the turn's last address is that entry's.
      push = false;
    }
    if (push) this.pageUrlPush = true;
    this.pageUrlSets = (this.pageUrlSets ?? 0) + 1;
    this.syncHistorySoon(push);
  }

  /** Whether an address pushed now can have its entry at once, in the task
   * the app pushed it in: no page has an entry (no modal, no stack screen
   * above its first), none is going, and no traversal is waited for. Then
   * nothing later in the turn can take an entry away under it. */
  canPushEarly() {
    if (this.historyDepth || this.ignoredPops || this.dismissing > 0 || this.popAnswer) return false;
    if ([...(this.root?.children ?? [])].some((el) => el._kind === "modal")) return false;
    return this.backDepth() === 0;
  }

  /**
   * A push with no page open (a list's row that opens a screen of its own
   * address): the entry is written now, before the browser draws the new
   * screen, not a task later (`syncHistorySoon`). Chrome on Android pictures
   * an entry as the page leaves it and shows that picture under a back
   * swipe; written after the new screen was drawn, the entry under it was
   * pictured with that screen. Later addresses of the same task replace
   * this entry's (in a turn the last one wins). With a page open it waits as
   * before: a sheet's dismissal can reach the player a task after the push,
   * and an entry written early would be gone back over with the sheet's.
   */
  pushEarly() {
    this.earlyPushed = true;
    setTimeout(() => {
      this.earlyPushed = false;
    }, 0);
    this.syncHistory();
  }

  // The document's title: a mounted `Head`'s (`nsh/web`), else the main
  // window's (`WindowRef.set({ title })`, where the app is the page), else
  // the page's own. A browser gives an entry the document's title while it
  // is current, so the title is written once the turn's entries exist: a
  // page pushed with it takes it, the entry left keeps its own, and on a
  // page popped it waits for the traversal to land.

  /** The title of `nsh/web`'s heads, merged (`null`: none sets one). */
  setHeadTitle(title) {
    this.headTitle = title ?? null;
    this.syncTitleSoon();
  }

  /** The main window's title; an empty one gives the page its own back. */
  setWindowTitle(title) {
    if (!this.history) return;
    this.windowTitle = title || null;
    this.syncTitleSoon();
  }

  syncTitleSoon() {
    if (this.pageTitle === undefined) this.pageTitle = document.title;
    if (this.titleSync) return;
    this.titleSync = setTimeout(() => {
      this.titleSync = 0;
      // `syncHistory` and a traversal's landing write it after theirs.
      if (!this.historySync && !this.ignoredPops) this.syncTitle();
    }, 0);
  }

  syncTitle() {
    if (this.pageTitle === undefined) return;
    const title = this.headTitle ?? this.windowTitle ?? this.pageTitle;
    if (document.title !== title) document.title = title;
  }

  backDepth() {
    let depth = [...this.root.children].filter((el) => el._kind === "modal" && !el._leaving).length;
    for (const el of this.views.values()) {
      if (el._kind === "stack" && this.stackShown(el)) {
        depth += Math.max(0, this.screensOf(el).length - 1);
      }
    }
    return depth;
  }

  /** Writes the turn's entries a task later, once all of it reached the
   * player; with `push` (an address pushed) at once when it can
   * (`pushEarly`). */
  syncHistorySoon(push = false) {
    if (!this.history) return;
    if (push && this.canPushEarly()) return this.pushEarly();
    if (this.historySync) return;
    this.historySync = setTimeout(() => {
      this.historySync = 0;
      this.syncHistory();
    }, 0);
  }

  syncHistory() {
    const depth = this.backDepth();
    const have = this.historyDepth;
    for (let i = have + 1; i <= depth; i++) this.pushEntry(i);
    if (depth < have && this.takeOverEntry(depth)) {
      // The address is on the entry the page that went had (`takeOverEntry`).
    } else if (depth < have) {
      // Back over the entries above `depth`, the addresses the user typed
      // at those depths included; a level that has no entry left gets one
      // once the traversal lands.
      const to = this.entryAtDepth(depth);
      const delta = to - this.historyIndex;
      // Where it lands, before it may (a browser lands later).
      this.historyIndex = to;
      this.historyDepth = Math.min(depth, this.historyDepths[to] ?? 0);
      this.ignoredPops++;
      history.go(delta);
    } else {
      this.historyDepth = depth;
    }
    // The address goes to the entry the traversal lands on (its
    // `popstate` syncs again).
    if (this.pageUrl != null && !this.ignoredPops) {
      const url = this.pageUrl;
      // An entry of its own, at the depth of the pages shown, when the
      // turn pushed no page's and the address is not the one shown.
      const push = this.pageUrlPush && depth <= have && url !== location.href;
      this.pageUrl = null;
      this.pageUrlPush = false;
      try {
        // Absolute: `setPageUrl` resolved it.
        if (push) this.pushEntry(depth, url);
        else history.replaceState(history.state, "", url);
        this.historyUrls[this.historyIndex] = url;
        this.shownUrl = url;
        if (!this.historyIndex) this.firstUrl = url;
      } catch (error) {
        this.showError(`UrlScheme.setUrl(${JSON.stringify(url)}): ${error?.message ?? error}`);
      }
    }
    if (!this.ignoredPops) this.syncTitle();
  }

  /**
   * A turn that takes away the one page whose entry is the current one (a
   * modal, a stack's screen) and pushes an address (a sheet's item that
   * opens a page of the app's): the address takes that entry over, at the
   * depth of the pages left, instead of going back over it and pushing an
   * entry of its own once the traversal lands. Nothing waits for a
   * traversal, and the entry under it is not left again. A browser pictures
   * an entry as the page leaves it, and Chrome on Android shows that
   * picture under a back swipe: left again here, after the app's new page
   * was drawn (the traversal lands a task or more later), the entry under
   * it was pictured with that page. Its picture stays the one taken as the
   * page that went came. Not with entries after the current one (the user
   * went back onto it), which a push drops and this would keep. Nor with
   * the address of the entry under it (a sheet with an address of its own
   * closing onto its opener's), which the back lands on and the push then
   * makes nothing of: here two entries of one address would have a back
   * between them that moves nothing. Returns whether it did.
   */
  takeOverEntry(depth) {
    const url = this.pageUrl;
    if (url == null || !this.pageUrlPush || url === location.href) return false;
    if (this.entryAtDepth(depth) !== this.historyIndex - 1 || this.historyDepths.length !== this.historyIndex + 1) return false;
    const under = this.historyUrls[this.historyIndex - 1];
    if (under == null || url === under) return false;
    this.pageUrl = null;
    this.pageUrlPush = false;
    try {
      // Absolute: `setPageUrl` resolved it.
      history.replaceState(this.historyState(depth), "", url);
    } catch (error) {
      this.showError(`UrlScheme.setUrl(${JSON.stringify(url)}): ${error?.message ?? error}`);
    }
    this.historyDepths[this.historyIndex] = depth;
    this.historyUrls[this.historyIndex] = url;
    this.historyDepth = depth;
    this.shownUrl = url;
    return true;
  }

  popState(e) {
    if (this.ignoredPops > 0) {
      if (--this.ignoredPops) return;
      // A traversal of the player's own landed: the address waiting for it
      // goes to the entry, or the core takes the entry's (the app did not
      // set one). Levels the entry lacks get theirs.
      if (this.historyDepth < this.backDepth()) this.syncHistorySoon();
      if (this.pageUrl != null) this.syncHistorySoon();
      else this.tellAddress(false);
      if (!this.historySync) this.syncTitle();
      return;
    }
    // A move of the user's: an answer the app owed for the one before is
    // not waited for any more.
    this.endPopAnswer();
    const have = this.historyDepth;
    if (e.state?.nshSession !== this.historySession) {
      if (e.state?.nsh == null && location.href !== this.shownUrl && !this.beforeFirstEntry()) {
        // An address the user gave the page (a `#fragment` typed in the
        // address bar): an entry after the current one, at its depth, as
        // if the app had pushed it. The app's pages stay; it shows what
        // the address names (`change`).
        const index = this.historyIndex + 1;
        this.historyDepths.length = index;
        this.historyDepths.push(have);
        this.historyUrls.length = index;
        this.historyUrls.push(location.href);
        this.historyIndex = index;
        history.replaceState(this.historyState(have, index), "");
        this.tellAddress("address");
        return;
      }
      // Back past the app's first entry: the app goes back to its start.
      // An earlier load's entries (a reload keeps them) are passed over,
      // as if the page had been left from its first screen.
      this.historyDepth = 0;
      this.historyIndex = 0;
      for (let i = 0; i < have; i++) if (!this.back()) break;
      if (e.state?.nsh == null) return;
      // An earlier load's entry (a reload keeps them): an address the app
      // is handed from outside, as a link (`open`). The entry becomes the
      // app's first, in a session of its own, so this load's entries after
      // it are an earlier load's too.
      this.historySession = newHistorySession();
      this.historyDepths = [0];
      this.historyUrls = [location.href];
      history.replaceState(this.historyState(0), "");
      this.historyBase = navigationIndex();
      this.firstUrl = location.href;
      this.tellAddress(true);
      return;
    }
    const at = e.state.nsh ?? 0;
    // This load's entries all have their place; which way the user went.
    const index = Number.isInteger(e.state.nshIndex) ? e.state.nshIndex : at;
    const reason = index < this.historyIndex ? "back" : "forward";
    this.historyIndex = index;
    this.historyDepths[index] = at;
    this.historyUrls[index] = location.href;
    if (at > have) {
      // Forward to a screen the stack no longer has: an address the app is
      // handed from outside, as a link (`open`), and its pages' entries go
      // on from here. An app that shows nothing for it goes back where it
      // was (`syncHistory`).
      this.historyDepth = at;
      this.tellAddress(true);
      this.syncHistorySoon();
      return;
    }
    if (at === have) {
      // Between entries of one depth (addresses the user typed): the app's
      // pages are as the entry has them, and it shows what the address
      // names.
      if (!index) this.firstUrl = location.href;
      this.tellAddress(location.href !== this.shownUrl ? reason : false);
      return;
    }
    // A pop the app hears at once (no motion, a modal) may give the address
    // itself from `onChange`, before the entry's below.
    const sets = this.pageUrlSets;
    const before = this.shownUrl;
    if (at < have) {
      // Back (several entries from the back button's menu): what the app
      // does not let go back gets its entry again.
      this.historyDepth = at;
      let popped = 0;
      while (at + popped < have && this.back()) popped++;
      const kept = at + popped < have;
      // The app kept its page: its entry keeps the address it showed (an
      // app's `onChange` sets the address of a page it went back to part of
      // the way).
      if (kept && !popped) this.pageUrl ??= this.shownUrl;
      this.syncHistorySoon();
      if (kept) return;
    }
    // The app went back: the address is the entry's (`UrlScheme.url()`),
    // with no `open`, as its stack went back already; a `setUrl` from its
    // `onChange` wins, whether it came during the pops or comes after.
    if (!index) this.firstUrl = location.href;
    if (this.pageUrlSets !== sets) {
      this.shownUrl = location.href;
      return;
    }
    this.tellAddress(false);
    // An app whose pages do not set the address (no `onChange` for them)
    // hears an entry's address that differs from the one it had
    // (`change`), once the pages it popped are dismissed: it answers the
    // dismissal after their slide, and an address it sets then wins.
    if (location.href !== before) this.awaitPopAnswer({ sets, url: location.href, reason });
  }

  /** Waits for the app's answer to a back that popped its pages (`popped`:
   * `sets`, `url`, `reason`), at most `POP_ANSWER_MS`. */
  awaitPopAnswer(popped) {
    this.popAnswer = popped;
    popped.timer = setTimeout(() => {
      popped.expired = true;
      this.settlePop();
    }, POP_ANSWER_MS);
    setTimeout(() => this.settlePop(), 0);
  }

  /** Once the pages a back popped are dismissed: the address is a
   * `change` unless the app set one meanwhile. */
  settlePop() {
    const popped = this.popAnswer;
    if (!popped || (this.dismissing > 0 && !popped.expired)) return;
    this.endPopAnswer();
    if (this.pageUrlSets !== popped.sets || location.href !== popped.url) return;
    this.tellAddress(popped.reason);
  }

  endPopAnswer() {
    clearTimeout(this.popAnswer?.timer);
    this.popAnswer = null;
  }

  /** Tells the core the entry's address: with `open` when the app is handed
   * it from outside (`true`), as a move the app did not make when `how` is
   * its reason (`"back"`, `"forward"`, `"address"`: `change`), else as the
   * address only (`quiet`). */
  tellAddress(how) {
    this.shownUrl = location.href;
    const url = this.shownUrl;
    const payload = how === true
      ? { url, page: true }
      : typeof how === "string" ? { url, page: true, change: how } : { url, page: true, quiet: true };
    this.event(ROOT_ID, "onUrlScheme", payload);
  }

  stackChanged(stack, added) {
    const screens = this.screensOf(stack);
    clearTimeout(stack._hideTimer);
    // The screen under the top one shows while the top one slides.
    stack._hideTimer = setTimeout(() => {
      screens.forEach((screen, i) => {
        if (i < screens.length - 1 && screen.parentNode === stack) screen.classList.add("nsh-hidden");
      });
    }, 400);
    screens.forEach((screen, i) => {
      const top = i === screens.length - 1;
      screen.classList.toggle("nsh-hidden", !(top || i === screens.length - 2));
      if (screen === added && i > 0) {
        const focus = document.activeElement;
        if (focus && focus !== document.body && this.root.contains(focus) && !added.contains(focus)) added._restoreFocus = focus;
      }
      // A slide leaves the one under it shifted (`moveScreens`).
      if (top) screen.style.transform = "";
      this.placeHeader(screen);
    });
    if (added && stack._frame) this.reportRoot(added, stack._frame[2], stack._frame[3], this.screenInsets(added));
    this.syncHistorySoon();
  }

  reportRoot(el, width, height, insets = [0, 0, 0, 0]) {
    const [top, right, bottom, left] = insets;
    this.call((w) => w.nsh_root_size(el._id, width, height, top, right, bottom, left));
  }

  // Modals

  op_mc([, id, animation, closeOnEscape]) {
    const el = this.view(id);
    if (!el) return;
    el._modal = { animation, closeOnEscape };
    if (el.isConnected && !el._leaving) this.placeModal(el);
    // Its config comes after its insert in the batch that presents it: it
    // starts out of sight the way it now comes in.
    if (el._entering) {
      el.style.transform = "";
      el.style.opacity = "";
      this.hideModal(el, this.modalMotion(el));
    }
  }

  /** Sizes presented modal `el` to the root (a transparent layer over it,
   * whatever its presentation) and reports its size and the safe area.
   * Over the window (`viewportDialogs`) the CSS sizes it: a popover at the
   * window's top left, wherever the container is, as large as the window
   * without its scroll bars. */
  placeModal(el) {
    const viewport = this.viewportDialogs;
    const [w, h] = viewport ? [el.clientWidth, el.clientHeight] : this.size;
    // The safe area is measured in the window's pixels; a layer at the
    // app's scale (`scaleLayer`) is laid out in the app's.
    const [sx, sy] = (viewport && this.frameScale) || [1, 1];
    const box = viewport ? { left: 0, top: 0, right: w * sx, bottom: h * sy } : undefined;
    const insets = this.safeProbe
      ? this.safeArea(box).map((inset, i) => Math.round(inset / (i % 2 ? sx : sy)))
      : [0, 0, 0, 0];
    const frame = [0, 0, w, h];
    el._frame = frame;
    if (!viewport) this.placeFrame(el);
    const key = `${frame[2]},${frame[3]},${insets}`;
    if (el._reported !== key) {
      el._reported = key;
      this.reportRoot(el, frame[2], frame[3], insets);
    }
  }

  /** The motion modal `el` comes and goes with: `"slide"`, `"fade"` or
   * `"none"` (slides fade when the user asked for less motion). */
  modalMotion(el) {
    const animation = el._modal?.animation ?? "slide";
    return animation === "slide" && this.reducedMotion?.matches ? "fade" : animation;
  }

  /** Modal `el` out of sight, as it starts and ends: below the root's
   * bottom edge (the window's, over the window), or transparent. */
  hideModal(el, motion) {
    const frame = el._frame ?? [0, 0, ...this.size];
    const below = (this.viewportDialogs ? frame[3] : this.size[1]) - frame[1];
    if (motion === "slide") el.style.transform = `translateY(${below}px)`;
    if (motion === "fade") el.style.opacity = "0";
  }

  present(el) {
    this.endNavShader(this.root);
    const motion = this.modalMotion(el);
    el._leaving = false;
    el.style.pointerEvents = "";
    this.dropLeftWith(el);
    el._closed = false;
    el._reported = null;
    // The focus leaves the views under it, and comes back when it closes.
    const focus = document.activeElement;
    el._restoreFocus = focus !== document.body && this.root.contains(focus) ? focus : null;
    el._restoreFocus?.blur();
    el.setAttribute("aria-modal", "true");
    this.root.append(el);
    if (this.viewportDialogs) {
      this.raise(el);
      // Alerts stay above the dialogs, as over the container.
      for (const alert of this.dialogs ?? []) this.raise(alert);
      // The window's size changes without a `resize` too: a scroll bar
      // of the page comes or goes.
      (this.viewportObserver ??= new ResizeObserver((entries) => {
        for (const { target } of entries) if (target.isConnected && !target._leaving) this.placeModal(target);
      })).observe(el);
    }
    this.placeModal(el);
    el.style.transition = "none";
    this.hideModal(el, motion);
    // This presentation's (truthy): a timer of an earlier one finds
    // another.
    const entering = el._entering = {};
    this.scopeFocus();
    this.syncHistorySoon();
    // In two frames, once its starting place has been drawn, or without
    // frames after a while (a hidden tab: its `onShow` still comes).
    const enter = () => {
      // Dismissed before it came in (`endPresentation` reported it shown),
      // or presented again meanwhile: nothing more to do.
      if (el._entering !== entering) return;
      el._entering = false;
      if (el._navShader && !this.viewportDialogs) {
        // Through its `transitionShader` over the root: it shows at once under it.
        el.style.transform = "";
        el.style.opacity = "";
        if (this.shaderNav(this.root, el, el._navShader, false, () => this.event(el._id, "onShow"))) {
          requestAnimationFrame(() => { el.style.transition = ""; });
          return;
        }
      }
      el.style.transition = "";
      el.style.transform = "";
      el.style.opacity = "";
      el._showTimer = setTimeout(() => {
        el._showTimer = 0;
        this.event(el._id, "onShow");
      }, motion === "none" ? 0 : 350);
    };
    requestAnimationFrame(() => requestAnimationFrame(enter));
    setTimeout(enter, ENTER_LATE_MS);
  }

  /**
   * Modal `el`'s presentation, if it is still under way, ends at once,
   * shown and reported, as a shader's does (`endNavShader`): one dismissed
   * before it came in, or while its own motion runs, reports `onShow`
   * before the dismissal, never after it.
   */
  endPresentation(el) {
    if (!el._entering && !el._showTimer) return;
    el._entering = false;
    clearTimeout(el._showTimer);
    el._showTimer = 0;
    this.event(el._id, "onShow");
  }

  /** Takes modal `el` away; `onDismiss` follows unless `reported`. */
  dismiss(el, reported = el._closed) {
    if (el._leaving) return;
    this.endNavShader(this.root);
    this.endPresentation(el);
    el._leaving = true;
    const motion = this.modalMotion(el);
    // Through its `transitionShader`: pictured as it shows, then gone under it at once.
    const shader = el._navShader && !this.viewportDialogs && this.shaderNav(this.root, el, el._navShader, true, () => {
      if (el._leaving) {
        el.remove();
        this.viewportObserver?.unobserve(el);
        this.releaseFrame(el);
        this.dropLeftWith(el);
      }
      if (!reported) this.event(el._id, "onDismiss");
    });
    if (shader) {
      el.style.transition = "none";
      el.style.opacity = "0";
      el.style.pointerEvents = "none";
    } else {
      this.hideModal(el, motion);
    }
    this.scopeFocus();
    this.syncHistorySoon();
    const restore = el._restoreFocus;
    if (restore?.isConnected && !this.topModal()) restore.focus({ preventScroll: true });
    if (shader) return;
    setTimeout(() => {
      if (el._leaving) {
        el.remove();
        this.viewportObserver?.unobserve(el);
        this.releaseFrame(el);
        this.dropLeftWith(el);
      }
      if (!reported) this.event(el._id, "onDismiss");
    }, motion === "none" ? 0 : 350);
  }

  /** Shows `el`, a child of the root, in the top layer over what is there
   * already (`viewportDialogs`): above the page around the container,
   * whatever its stacking, transforms and clipping. Moving it in the DOM,
   * as appending does, takes it out of the top layer. */
  /** Keep the app's layout fixed while its iframe covers the host page. */
  holdFrame(el) {
    if (typeof window === "undefined") return;
    const layers = this.frameLayers ??= new Set();
    if (layers.has(el)) return;
    layers.add(el);
    if (layers.size > 1) return;
    this.viewportPageRelease = lockViewportPage(this.root);
    if (window.parent === window) return;
    const root = this.root, box = root.getBoundingClientRect();
    const properties = ["position", "left", "top", "width", "height", "transform", "transform-origin"];
    const saved = properties.map((p) => [p, root.style.getPropertyValue(p), root.style.getPropertyPriority(p)]);
    const backgrounds = [document.documentElement, document.body].map((node) =>
      [node, node.style.getPropertyValue("background"), node.style.getPropertyPriority("background")]);
    for (const [node] of backgrounds) node.style.setProperty("background", "transparent", "important");
    const pin = (rect) => {
      const values = ["fixed", `${rect.left + box.left * rect.sx}px`, `${rect.top + box.top * rect.sy}px`,
        `${root.clientWidth}px`, `${root.clientHeight}px`, `scale(${rect.sx},${rect.sy})`, "0 0"];
      properties.forEach((p, i) => root.style.setProperty(p, values[i], "important"));
    };
    pin({ left: 0, top: 0, sx: 1, sy: 1 });
    const session = this.frameSession = { close: null };
    let cancelled = false, release, timer;
    const close = session.close = () => {
      if (cancelled) return;
      cancelled = true; clearTimeout(timer);
      window.removeEventListener("pagehide", close);
      for (const [p, value, priority] of saved) root.style.setProperty(p, value, priority);
      for (const [node, value, priority] of backgrounds) node.style.setProperty("background", value, priority);
      release?.();
      if (this.frameSession === session) {
        this.frameSession = null;
        this.frameScale = null;
        for (const layer of layers) this.scaleLayer(layer);
      }
    };
    window.addEventListener("pagehide", close, { once: true });
    const ready = (lease) => {
      if (cancelled) { lease.release(); return; }
      release = lease.release; pin(lease.rect);
      this.frameScale = [lease.rect.sx, lease.rect.sy];
      for (const layer of layers) {
        this.scaleLayer(layer);
        if (layer._kind === "modal") this.placeModal(layer);
      }
    };
    try {
      if (window.frameElement) {
        ready(frameViewport(window.frameElement, usedColorScheme(document)));
        return;
      }
    } catch (error) {
      console.warn("[nsh] iframe viewport host:", error);
    }
    const channel = new MessageChannel();
    release = () => { channel.port1.postMessage("release"); channel.port1.close(); };
    channel.port1.onmessage = ({ data }) => {
      clearTimeout(timer);
      if (data.error) { console.warn("[nsh] iframe viewport host:", data.error); close(); return; }
      ready({ rect: data, release });
    };
    // The parent opted in with hostPlayerFrame(frame); the transferred port
    // is private to this request, and its host checks the source window.
    const request = () => {
      if (cancelled) return;
      window.parent.postMessage({ type: "nsh:viewport", colorScheme: usedColorScheme(document) }, "*", [channel.port2]);
      timer = setTimeout(() => {
        console.warn("[nsh] install hostPlayerFrame(iframe) on the embedding page for viewport dialogs");
        close();
      }, 1500);
    };
    // The host releases the previous document's leases on iframe load.
    // Send after this document's load, including for initially open dialogs.
    if (document.readyState === "complete") request();
    else window.addEventListener("load", request, { once: true });
  }

  releaseFrame(el) {
    this.frameLayers?.delete(el);
    if (!this.frameLayers?.size) {
      this.frameSession?.close();
      this.viewportPageRelease?.(); this.viewportPageRelease = null;
    }
  }

  raise(el) {
    this.holdFrame(el);
    if (!el.popover) {
      el.classList.add("nsh-viewport");
      el.popover = "manual";
      // A blocking wheel listener of its own: the browser waits for the
      // root's (`wheel`) only over the root's box, and scrolls the page
      // under the rest of the layer at once.
      el.addEventListener("wheel", () => {}, { passive: false });
    }
    if (el.matches(":popover-open")) el.hidePopover();
    el.showPopover();
    this.scaleLayer(el);
  }

  /** Draws layer `el` over the window at the app's scale: the website
   * shows its phone and desktop frames scaled down, and a dialog over the
   * page keeps the size it has in the app. It is laid out as large as the
   * window divided by that scale, then scaled to cover the window. */
  scaleLayer(el) {
    const [sx, sy] = this.frameScale ?? [1, 1];
    const scaled = sx !== 1 || sy !== 1;
    if (!scaled && !el._scaled) return;
    el._scaled = scaled;
    el.style.width = scaled ? `${100 / sx}%` : "";
    el.style.height = scaled ? `${100 / sy}%` : "";
    el.style.scale = scaled ? `${sx} ${sy}` : "";
    el.style.transformOrigin = scaled ? "0 0" : "";
  }

  // Overlays over the window ------------------------------------------

  /** `overlays: "viewport"`: follows where the root is in the window, which
   * the page's scrolling and layout move, and the presses on the page
   * around it. */
  installFloats() {
    const moved = () => this.placeFloats();
    // Any scroll view of the page around the container moves it: a
    // capturing listener hears them all. The app's own scroll views move
    // nothing of it, and their scrolling is a hot path: left alone.
    addEventListener("scroll", (e) => {
      if (!(e.target instanceof Node && this.root.contains(e.target))) moved();
    }, { capture: true, passive: true });
    addEventListener("resize", moved);
    // The on-screen keyboard shrinks the visual viewport only.
    visualViewport?.addEventListener("resize", moved);
    // What is above the container on the page changing size moves it
    // without a scroll.
    new ResizeObserver(moved).observe(document.documentElement);
    document.addEventListener("pointerdown", (e) => this.pressAround(e), true);
    this.placeFloats();
  }

  /**
   * Anchored overlays drawn over the window (`overlays: "viewport"`): the
   * root's children from its first overlay placed against an anchor on
   * (the core puts the overlays above the root's own views, in the order
   * they stack) are manual popovers in the browser's top layer, so the
   * container's clipping, stacking and transforms leave them whole. Each
   * stays where it is in the root, so its events, focus and `inert` are as
   * before; the overlays shown after it are lifted with it, to stay above
   * it. Overlays without an anchor before the first (a fixed view, a
   * backdrop) stay in the container. A lifted view the batch moved in the
   * DOM left the top layer, and is raised again with those above it.
   */
  syncFloats() {
    const lifted = [];
    for (const child of this.root.children) {
      if (child._id === undefined || child._kind === "modal") continue;
      if (lifted.length || child._props?.anchored) lifted.push(child);
    }
    const before = this.floats ?? [];
    let kept = 0;
    while (kept < lifted.length && lifted[kept] === before[kept] && lifted[kept].matches(":popover-open")) kept++;
    for (const el of before) if (!lifted.includes(el)) this.sinkFloat(el);
    if (kept === lifted.length) {
      this.floats = lifted;
      return;
    }
    // Raising again what is open takes the focus out of it.
    const focus = document.activeElement;
    for (const el of lifted.slice(kept)) this.liftFloat(el);
    this.floats = lifted;
    // Dialogs and alerts over the window stay above them.
    for (const layer of this.root.children) {
      if (layer.classList.contains("nsh-viewport") && layer.matches(":popover-open")) {
        layer.hidePopover();
        layer.showPopover();
      }
    }
    if (focus && focus !== document.activeElement && focus.isConnected) focus.focus({ preventScroll: true });
    this.placeFloats();
  }

  /** Shows overlay `el` in the top layer, above what is there already. */
  liftFloat(el) {
    el.classList.add("nsh-float");
    el.popover = "manual";
    // As a dialog's layer (`raise`): the browser waits for the root's
    // blocking `wheel` listener only over the root's box. Added once, and
    // again to a view drawn as another element since (`retag`).
    el.addEventListener("wheel", noop, { passive: false });
    if (el.matches(":popover-open")) el.hidePopover();
    el.showPopover();
  }

  /** Overlay `el` is drawn in the container again (or went). */
  sinkFloat(el) {
    if (!el.classList.contains("nsh-float")) return;
    if (el.matches(":popover-open")) el.hidePopover();
    el.removeAttribute("popover");
    el.classList.remove("nsh-float");
    el.removeEventListener("wheel", noop);
  }

  /**
   * Where the lifted overlays go: their frames are in the root's
   * coordinates, moved by where the root is in the window (its CSS
   * variables), and the core places them in the window less its safe
   * area, in those coordinates (`nsh_overlay_area`), so they flip and
   * stay inside it by the window's edges rather than the container's.
   */
  placeFloats() {
    if (!this.wasm || this.stopping) return;
    const r = this.root.getBoundingClientRect();
    const x = `${r.left}px`, y = `${r.top}px`;
    if (this.floatOrigin !== x + y) {
      this.floatOrigin = x + y;
      this.root.style.setProperty("--nsh-float-x", x);
      this.root.style.setProperty("--nsh-float-y", y);
    }
    // The window without its scroll bars, less its safe area.
    const doc = document.documentElement;
    const [w, h] = [doc.clientWidth, doc.clientHeight];
    const [top, right, bottom, left] = this.safeProbe
      ? this.safeArea({ left: 0, top: 0, right: w, bottom: h })
      : [0, 0, 0, 0];
    // Not under the on-screen keyboard, which covers the layout viewport's
    // bottom (as `keyboardHeight`; not while zoomed).
    const vv = visualViewport;
    const visible = vv && vv.scale <= 1.01 ? Math.min(h, vv.offsetTop + vv.height) : h;
    const area = [left - r.left, top - r.top, Math.max(0, w - left - right), Math.max(0, visible - top - bottom)];
    const key = area.join();
    if (this.floatArea === key) return;
    this.floatArea = key;
    this.call((wasm) => wasm.nsh_overlay_area(...area));
  }

  /** A press on the page around the container while overlays are lifted
   * over it: they hear `onPressOutside`, as for a press in the root
   * outside them (a popover closes). */
  pressAround(e) {
    if (!this.floats?.length || this.stopping || !this.wasm) return;
    if (e.target instanceof Node && this.root.contains(e.target)) return;
    const [x, y] = this.point(e, null);
    this.call((w) => w.nsh_press_outside(x, y));
  }

  /** Going back or Escape on a modal: it asks to close (`onRequestClose`,
   * reason `"cancel"`); with `closeOnEscape` it closes natively, then
   * reports `onDismiss`. */
  requestClose(el) {
    this.event(el._id, "onRequestClose", { reason: "cancel" });
    if ((el._modal?.closeOnEscape ?? true) && !el._leaving) {
      el._closed = true;
      this.event(el._id, "onDismiss");
      this.dismiss(el, true);
    }
  }

  /** Only the newest modal or dialog takes the focus, input and the
   * screen reader: what lies under it is inert. */
  scopeFocus() {
    const top = this.dialogs?.[this.dialogs.length - 1] ?? this.topModal();
    for (const child of this.root.children) {
      if (child === this.live || child.classList.contains("nsh-error")) continue;
      child.inert = (child._kind === "modal" && !!child._leaving) || (!!top && child !== top);
    }
  }

  // Web views and videos

  /**
   * A web view is an <iframe>. HTML (`html`) loads as
   * `srcdoc` in a sandbox with an origin of its own (it never reaches the
   * player's page), with a bridge script first: the page's
   * `window.nsh.postMessage(data)` reaches `onMessage`
   * through a `MessageChannel`, and `injectJavaScript` runs through it.
   * `injectedJavaScriptBeforeContentLoaded` / `injectedJavaScript` are
   * scripts at the document's start and end. A URL loads as it is
   * (sandboxed without its origin when it is the player's own); the browser
   * hides what such a page does, so it only gets `postMessage` and load
   * events, with the URL it was given.
   */
  op_web([, id, url, html, base, before, after, scroll, js]) {
    const el = this.view(id);
    const frame = el?._frameEl;
    if (!frame) return;
    const key = JSON.stringify([url, html, base, before, after, scroll, js]);
    if (el._web === key) return;
    el._web = key;
    el._port?.close();
    el._port = null;
    el._token = html != null && js ? Math.random().toString(36).slice(2) : null;
    const sandbox = ["allow-forms", "allow-popups", "allow-popups-to-escape-sandbox", "allow-modals", "allow-downloads"];
    if (js) sandbox.push("allow-scripts");
    let same = false;
    if (html == null && url) {
      try {
        same = new URL(url, location.href).origin === location.origin;
      } catch {
        // Not a URL the frame can load anyway.
      }
      // Pages of other sites keep their own origin (their storage works); one of the player's own must not reach it.
      if (!same) sandbox.push("allow-same-origin");
    }
    frame.setAttribute("sandbox", sandbox.join(" "));
    if (html != null) {
      let head = "";
      if (base) head += `<base href="${base.replace(/"/g, "&quot;")}">`;
      // By URL where the browser host is (`browser/web-bridge.js`): a
      // strict `script-src` the web view inherits allows it ('self').
      const bridge = this.browserHost?.webBridge;
      if (el._token) {
        head += bridge
          ? `<script src="${bridge.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}" data-nsh-token="${el._token}"></script>`
          : `<script>${webBridge(el._token)}</script>`;
      }
      if (!scroll) head += "<style>html,body{overflow:hidden!important}</style>";
      if (before) head += `<script>${before.replace(/<\/script/gi, "<\\/script")}</script>`;
      const tail = after ? `<script>${after.replace(/<\/script/gi, "<\\/script")}</script>` : "";
      // After a doctype, which must stay first (quirks mode otherwise).
      const doctype = /^\s*<!doctype[^>]*>/i.exec(html)?.[0] ?? "";
      el._webUrl = base ?? "about:srcdoc";
      el._webTitle = new DOMParser().parseFromString(html, "text/html").title;
      frame.removeAttribute("src");
      frame.removeAttribute("scrolling");
      frame.srcdoc = doctype + head + html.slice(doctype.length) + tail;
    } else {
      el._webUrl = url ?? "";
      el._webTitle = "";
      frame.removeAttribute("srcdoc");
      if (scroll) frame.removeAttribute("scrolling");
      else frame.setAttribute("scrolling", "no");
      // A relative URL is the site's (`linkHref`), which no `<base href>`
      // names when the page gives it to the player.
      if (url) frame.src = this.siteBase ? this.linkHref(url) : url;
      else frame.removeAttribute("src");
    }
    // After the batch: its events may come after its props.
    if (html != null || url) queueMicrotask(() => this.webNavigation(el, "onLoadStart", true));
  }

  webNavigation(el, name, loading) {
    const state = { url: el._webUrl ?? "", title: el._webTitle ?? "", loading, canGoBack: false, canGoForward: false };
    if (el._events.has(name)) this.event(el._id, name, state);
    if (el._events.has("onNavigationStateChange")) this.event(el._id, "onNavigationStateChange", state);
  }

  webLoaded(el) {
    const frame = el._frameEl;
    if (!frame.getAttribute("src") && !frame.hasAttribute("srcdoc")) return;
    if (el._token) {
      const channel = new MessageChannel();
      channel.port1.onmessage = (e) => {
        if (el._events.has("onMessage")) this.event(el._id, "onMessage", { data: String(e.data) });
      };
      el._port?.close();
      el._port = channel.port1;
      frame.contentWindow?.postMessage(el._token, "*", [channel.port2]);
    }
    this.webNavigation(el, "onLoad", false);
  }

  op_video([, id, src, paused, muted, volume, rate, repeat, fit, controls, progressInterval]) {
    const el = this.view(id);
    const video = el?._video;
    if (!video) return;
    const url = src ? this.asset(src) : "";
    // `paused` is acted on when it changes (or for a new source): `play()`
    // on a video that ended starts it over, and one its controls paused
    // would play on, whenever another prop (the volume, say) changed.
    const toggled = url !== el._src || paused !== el._paused;
    el._paused = paused;
    if (url !== el._src) {
      el._src = url;
      if (url) video.src = url;
      else video.removeAttribute("src");
    }
    el._progressInterval = progressInterval > 0 ? progressInterval : 250;
    video.muted = muted;
    video.volume = Math.min(1, Math.max(0, volume));
    video.playbackRate = rate;
    video.loop = repeat;
    video.controls = controls;
    video.className = `nsh-fill nsh-fit-${fit}`;
    if (!toggled) return;
    if (paused) video.pause();
    else if (url && video.paused) this.playVideo(el, video);
  }

  /** Plays `<Video>` `el`'s media element `video`, as its props say. */
  playVideo(el, video) {
    const src = el._src;
    video.play().catch((err) => {
      if (err?.name !== "NotAllowedError") return;
      // Browsers only start sound on their own after a user gesture: the
      // next update tries again, though `paused` did not change.
      if (el._src === src && el._paused === false) el._paused = null;
      if (!el._autoplayWarned) {
        el._autoplayWarned = true;
        console.warn("[nsh] the browser did not let the video play before a user gesture (muted videos can)");
      }
    });
  }

  /** `<Video>`'s events from the media element's. */
  wireVideo(el, video) {
    const emit = (name, payload) => el._events.has(name) && this.event(el._id, name, payload);
    const progress = () => emit("onProgress", { currentTime: video.currentTime, duration: video.duration || 0 });
    const stopProgress = () => {
      clearInterval(el._progressTimer);
      el._progressTimer = 0;
    };
    let buffering = false;
    const buffer = (on) => {
      if (buffering === on) return;
      buffering = on;
      emit("onBuffer", { isBuffering: on });
    };
    video.addEventListener("loadstart", () => {
      if (video.getAttribute("src")) emit("onLoadStart");
    });
    video.addEventListener("loadedmetadata", () =>
      emit("onLoad", { duration: video.duration || 0, width: video.videoWidth, height: video.videoHeight }));
    video.addEventListener("playing", () => {
      buffer(false);
      stopProgress();
      if (el._events.has("onProgress")) el._progressTimer = setInterval(progress, el._progressInterval ?? 250);
    });
    video.addEventListener("pause", () => {
      stopProgress();
      progress();
      // Out of the document, the browser paused it: one the app has not
      // paused plays on when it is back (`op_i`).
      if (!video.isConnected && el._paused === false) (this.leftPlaying ??= new Set()).add(el);
    });
    video.addEventListener("waiting", () => buffer(true));
    video.addEventListener("canplay", () => buffer(false));
    video.addEventListener("ended", () => {
      stopProgress();
      progress();
      emit("onEnd");
    });
    video.addEventListener("error", () => {
      stopProgress();
      const e = video.error;
      if (e && video.getAttribute("src")) emit("onError", { message: e.message || `media error ${e.code}` });
    });
  }

  // Commands

  op_cmd([, id, name, ...args]) {
    const el = this.view(id);
    switch (name) {
      case "focus":
        if (el?._field) {
          el._field.focus();
          this.pressFocus = el._field;
        } else if (el) this.focusPressable(el);
        break;
      case "blur":
        if (el?._field) el._field.blur();
        else document.activeElement?.blur?.();
        break;
      case "clearSelection": {
        // The selection of the selectable view `el` is, is in or holds:
        // `selectionchange` then reports `""`.
        const sel = getSelection();
        const anchor = sel?.rangeCount ? sel.anchorNode : null;
        const area = anchor && this.areaOf(anchor.nodeType === 1 ? anchor : anchor.parentElement);
        if (el && area && (el.contains(area) || area.contains(el))) sel.removeAllRanges();
        break;
      }
      case "setSelection": el?._field?.setSelectionRange(args[0], args[1]); break;
      case "insertText": {
        // As the user's typing: the browser's undo history keeps it and
        // `input` reports it. `execCommand` edits the focused field only.
        const field = el?._field;
        if (!field) break;
        if (field._composing) {
          // The input method's text would be committed around it (as on Linux).
          console.warn("insertText: an input method is composing; nothing inserted");
          break;
        }
        if (document.activeElement !== field) field.focus();
        if (!document.execCommand("insertText", false, args[0])) {
          field.setRangeText(args[0], field.selectionStart, field.selectionEnd, "end");
          field.dispatchEvent(new Event("input", { bubbles: true }));
        }
        break;
      }
      case "scrollTo":
        if (!el) break;
        // A textarea's text (a built-in bar's drags).
        if (el._field) {
          el._field.scrollTo({ top: args[1], behavior: args[2] ? "smooth" : "instant" });
          break;
        }
        this.scrollCommand(el, args[0], args[1], args[2]);
        break;
      case "scrollToEnd": {
        if (!el) break;
        const [x, y] = el._horizontal ? [el.scrollWidth, 0] : [0, el.scrollHeight];
        this.scrollCommand(el, x, y, args[0]);
        break;
      }
      case "zoomTo": if (el) this.zoomCommand(el, ...args); break;
      case "setResponder": this.responderBlocks = !!args[0]; break;
      case "clearResponder": this.responderBlocks = false; break;
      case "dialog":
        this.dialog(args[0], args[1], args[2], args[3], args[4] ?? [], args[5] ?? true, args[6] ?? false,
          args[7] ?? null, args[8] ?? null, args[9] ?? false, args[10] ?? false);
        break;
      case "closeDialog": this.closeDialog(args[0]); break;
      case "reload": {
        const frame = el?._frameEl;
        if (!frame) break;
        // The frame is another origin: it is loaded again rather than told to.
        if (frame.hasAttribute("srcdoc")) frame.srcdoc = frame.srcdoc;
        else if (frame.getAttribute("src")) frame.src = frame.getAttribute("src");
        this.webNavigation(el, "onLoadStart", true);
        break;
      }
      case "postMessage": el?._frameEl?.contentWindow?.postMessage(args[0], "*"); break;
      case "injectJavaScript":
      case "goBack":
      case "goForward":
        if (el?._port) el._port.postMessage(name === "injectJavaScript" ? { eval: args[0] } : { go: name === "goBack" ? -1 : 1 });
        else if (el?._frameEl && !el._noBridgeWarned) {
          el._noBridgeWarned = true;
          console.warn(`[nsh] web view: ${name} only reaches HTML sources (a page of another site is the browser's own)`);
        }
        break;
      case "seek": {
        const video = el?._video;
        if (!video) break;
        const ended = video.ended;
        video.currentTime = args[0];
        // The browser paused it at its end: one the app has not paused
        // plays on from where it was sought, as on the other platforms.
        if (ended && el._paused === false && !video.loop) this.playVideo(el, video);
        break;
      }
      case "notificationPermission": this.notificationPermission(args[0], args[1]); break;
      case "showNotification": this.showNotification(args[0], args[1], args[2], args[3], args[4]); break;
      case "closeNotification": this.notifications?.get(args[0])?.close(); break;
      case "closeAllNotifications":
        for (const notification of this.notifications?.values() ?? []) notification.close();
        this.notifications?.clear();
        break;
      case "audioLoad": this.audioLoad(args[0], () => this.audioBytesFromBase64(args[1]), args[3]); break;
      case "audioLoadUrl": this.audioLoad(args[0], () => this.audioFetch(args[1], args[2]), args[3]); break;
      case "audioPlay": this.audioPlay(args[0], args[1], args[2]); break;
      case "audioStop": this.audioStop(args[0]); break;
      case "audioUnload": this.audioUnload(args[0]); break;
      case "playerOpen": this.playerOpen(args[0], args[1], { volume: args[2], rate: args[3], loop: args[4] }); break;
      case "playerPreload": this.playerPreload(args[0]); break;
      case "playerResume": this.playerResume(args[0]); break;
      case "playerPause": this.playerPause(args[0]); break;
      case "playerSeek": this.playerSeek(args[0], args[1]); break;
      case "playerSet": this.playerSet(args[0], { volume: args[1], rate: args[2], loop: args[3] }); break;
      case "playerClose": this.playerClose(args[0]); break;
      case "setBadge": this.setBadge(args[0]); break;
      case "openUrl": this.event(ROOT_ID, "onOpenUrl", { id: args[0], opened: this.openUrl(args[1]) }); break;
      case "setClipboard": this.writeClipboard(args[0], undefined, (written) => this.event(ROOT_ID, "onClipboardWrite", { written })); break;
      case "setClipboardItem": this.writeClipboard(args[0], args[1] ?? undefined, (written) => this.event(ROOT_ID, "onClipboardWrite", { written })); break;
      case "readClipboard": this.readClipboard(args[0], args[1]); break;
      case "setClipboardImage": this.writeClipboardImage(args[0]); break;
      case "readClipboardImage": this.readClipboardImage(args[0], args[1]); break;
      // Pages see no local paths: never any files.
      case "readClipboardFiles": this.event(ROOT_ID, "onClipboard", { id: args[0], has: false, files: "" }); break;
      case "pickScreenColor": this.pickScreenColor(args[0]); break;
      case "share": this.share(args[0], args[1], args[2], args[3], args[4]); break;
      case "renderCanvas": this.renderCanvas(...args); break;
      case "pickImages": this.pickImages(args[0], args[1], args[2], args[3], args[4]); break;
      case "pickFiles": this.pickFiles(args[0], args[1], args[2], args[3]); break;
      case "hostCall": this.hostCall(args[0], args[1], args[2]); break;
      case "hostPost": this.hostPost(args[0], args[1]); break;
      case "imageInfo": this.imageInfo(args[0], args[1]); break;
      case "back": this.defaultBack(); break;
      case "setAppUrl": this.setPageUrl(args[0]); break;
      case "pushAppUrl": this.setPageUrl(args[0], true); break;
      case "quitOnRequest": this.askBeforeLeaving(!args[0]); break;
      // The app's `quit()`: its answer while it is asked about leaving the
      // page (the page may go); a page cannot close its own tab, so at
      // other times the page stays as it is.
      case "quit": if (this.quitAsked) this.quitAsked.granted = true; break;
      case "setTitle": this.setWindowTitle(args[0]); break;
      case "exitApp": {
        const app = this.app;
        // Finish the current engine call before releasing its surface.
        queueMicrotask(() => { if (this.app === app) this.reset(); });
        break;
      }
      case "announce":
        this.announce(args[0]);
        break;
      case "a11yFocus":
        if (!el) break;
        // An input: its field, as `focus` gives it.
        if (el._field) {
          el._field.focus();
          break;
        }
        // A page moves a screen reader only with the keyboard focus: a
        // field the user is typing in keeps it, and the view is read out
        // instead, as the screen reader would read it there.
        if (this.typing(el)) {
          const text = (el.getAttribute("aria-label") || el.textContent || "").trim();
          if (text) this.announce(text);
          break;
        }
        if (!el.hasAttribute("tabindex")) {
          el.tabIndex = -1;
          el._a11yFocus = true;
        }
        el.focus({ preventScroll: true });
        break;
      default: break;
    }
  }



  /** Whether leaving the page (closing its tab, reloading, going to
   * another site) asks the app first: on while the app listens to quit
   * requests (`quitOnRequest` false). A `beforeunload` listener can keep a
   * page out of the back / forward cache in some browsers, so it is there
   * only while it is needed. */
  askBeforeLeaving(ask) {
    if (typeof window === "undefined" || !ask === !this.leaveGuard) return;
    if (ask) {
      this.leaveGuard = (event) => {
        if (this.deliverQuitRequest()) return;
        event.preventDefault();
        // Browsers before `preventDefault` was enough.
        event.returnValue = "";
      };
      window.addEventListener("beforeunload", this.leaveGuard);
    } else {
      window.removeEventListener("beforeunload", this.leaveGuard);
      this.leaveGuard = null;
    }
  }

  /** The user is leaving the page: the app hears the quit request as the
   * desktops' quit key reports it, its listeners running before this
   * returns. Whether the app quit meanwhile: the page then leaves without
   * asking. Otherwise the browser asks the user, and what the listeners
   * started (their own question, a save) is on the page should the user
   * stay. A request the engine cannot take now (it is running: the page
   * left from inside an engine call) or that fails leaves the question to
   * the browser. This only decides: `beforeunload` comes before the
   * browser commits to leaving, and the page may still stay (the user
   * cancels another listener's question, the navigation is a download),
   * so the app's quit listeners start only once the page is really gone
   * (`watchPageEnd`). */
  deliverQuitRequest() {
    if (this.depth > 0 || this.trapped) return false;
    const asked = { granted: false };
    this.quitAsked = asked;
    try {
      this.call((w) => w.nsh_quit_request());
    } catch (err) {
      console.error("[nsh]", err);
      return false;
    } finally {
      this.quitAsked = null;
    }
    return asked.granted;
  }

  /** While an app runs: the page being discarded ends it, as the process
   * ending ends a desktop app, whichever way the user left (the app let
   * the page go, the user chose to leave in the browser's question,
   * nothing listened to quit requests). Its quit listeners start then,
   * once (`nsh_quit`): what they do synchronously completes, work they
   * await runs for as long as the page remains. A `pagehide` that keeps
   * the page in the back / forward cache (`persisted`) ends nothing: the
   * app runs on when the page comes back. A `pagehide` listener keeps no
   * page out of that cache. */
  watchPageEnd(watch) {
    if (typeof window === "undefined" || !watch === !this.pageEnd) return;
    if (watch) {
      this.pageEnd = (event) => {
        if (event.persisted) return;
        this.watchPageEnd(false);
        this.call((w) => w.nsh_quit());
      };
      window.addEventListener("pagehide", this.pageEnd);
    } else {
      window.removeEventListener("pagehide", this.pageEnd);
      this.pageEnd = null;
    }
  }

  /** Has screen readers read `text` (`announce`), through the live region. */
  announce(text) {
    // Cleared first: the same text again is announced again.
    this.live.textContent = "";
    setTimeout(() => { this.live.textContent = text; }, 50);
  }

  /** Whether the keyboard focus is in a text field, other than `el`, that
   * the user may be typing in (`setAccessibilityFocus` leaves it there). */
  typing(el) {
    const a = document.activeElement;
    if (!a || a === el || !a.isConnected || a.closest?.("[inert]")) return false;
    if (a.isContentEditable) return true;
    if (a.tagName === "TEXTAREA") return true;
    return a.tagName === "INPUT" && !/^(button|checkbox|color|file|hidden|image|radio|range|reset|submit)$/.test(a.type);
  }

  /**
   * `Clipboard.writeText` / `write`: `text`, and `html` when given as
   * `text/html` beside it (one item, as a browser copies a selection).
   * Within the user's gesture (a key or a press whose batch is applied
   * while its event runs, as a RichEditor's copy is) a copy command whose
   * event takes the types, as ProseMirror copies: synchronous, with no
   * permission or secure context. Else the async Clipboard API (a secure
   * context; some browsers want a gesture), then a copy command over a
   * selected offscreen text area.
   */
  writeClipboard(text, html, done = () => {}) {
    if (navigator.userActivation?.isActive !== false && this.copyCommand(text, html)) return done(true);
    const copy = () => {
      const focused = document.activeElement;
      const area = document.createElement("textarea");
      area.value = text;
      area.className = "nsh-offscreen";
      document.body.append(area);
      // Safari copies only a selection.
      area.select();
      const written = this.copyCommand(text, html);
      area.remove();
      // The selection took the focus from the field that had it (a
      // RichEditor's input).
      if (focused && focused !== document.body && focused.isConnected) focused.focus({ preventScroll: true });
      done(written);
    };
    if (html !== undefined && navigator.clipboard?.write && typeof ClipboardItem === "function") {
      const item = new ClipboardItem({
        "text/plain": new Blob([text], { type: "text/plain" }),
        "text/html": new Blob([html], { type: "text/html" }),
      });
      navigator.clipboard.write([item]).then(() => done(true), copy);
    } else if (html === undefined && navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(() => done(true), copy);
    } else {
      copy();
    }
  }

  /** A copy command whose `copy` event puts `text`, and `html` when
   * given, on the clipboard; whether it did. Cancelling `beforecopy` lets
   * Blink and WebKit copy with nothing selected. */
  copyCommand(text, html) {
    const doc = globalThis.document;
    if (typeof doc?.execCommand !== "function") return false;
    let done = false;
    const enable = (event) => event.preventDefault();
    const fill = (event) => {
      if (!event.clipboardData) return;
      event.clipboardData.setData("text/plain", text);
      if (html !== undefined) event.clipboardData.setData("text/html", html);
      event.preventDefault();
      // Not the copy of selected text (`copyText`) as well.
      event.stopImmediatePropagation();
      done = true;
    };
    doc.addEventListener("beforecopy", enable, true);
    doc.addEventListener("copy", fill, true);
    try {
      doc.execCommand("copy");
    } catch {
      // Refused: the caller tries the next way.
    } finally {
      doc.removeEventListener("beforecopy", enable, true);
      doc.removeEventListener("copy", fill, true);
    }
    return done;
  }

  /**
   * `Clipboard.readText` / `hasText`: browsers only tell by reading,
   * which may ask the user (Chromium asks once per site; Safari and Firefox
   * show a paste button), and fails in an insecure context. `hasText`
   * reads too: there is no way to ask without reading.
   */
  // `pickScreenColor`: the browser's eyedropper (`EyeDropper`, which the
  // environment's `screenColor` reports). The color packed as 0xRRGGBBAA;
  // none when the user pressed Escape.
  async pickScreenColor(request) {
    let color;
    try {
      const { sRGBHex } = await new EyeDropper().open();
      color = parseInt(sRGBHex.slice(1, 7), 16) * 256 + 255;
    } catch {}
    this.event(ROOT_ID, "onScreenColor", color === undefined ? { id: request } : { id: request, color });
  }

  // `share`: the browser's share sheet (`navigator.share`, which the
  // environment's `share` reports). A page has no local files to share, and
  // a browser that cannot share this content says so: both are reported as
  // unavailable, never as shared. The user closing the sheet rejects with
  // an `AbortError`: dismissed.
  async share(request, title, text, url, files) {
    const unavailable = (error) => this.event(ROOT_ID, "onShare",
      { id: request, error, code: "ERR_FEATURE_UNAVAILABLE_ON_PLATFORM" });
    const data = {};
    if (title != null) data.title = title;
    if (text != null) data.text = text;
    if (url != null) data.url = url;
    if (files) return unavailable("share: a page shares no local files");
    if (!webShareAllowed()) return unavailable("share: this browser has no share sheet for this page");
    if (typeof navigator.canShare === "function" && !navigator.canShare(data)) {
      return unavailable("share: this browser cannot share this content");
    }
    try {
      await navigator.share(data);
      this.event(ROOT_ID, "onShare", { id: request, action: "shared" });
    } catch (err) {
      if (err?.name === "AbortError") {
        this.event(ROOT_ID, "onShare", { id: request, action: "dismissed" });
      } else if (err?.name === "NotAllowedError") {
        // The browser refuses the sheet here: the page's permissions policy
        // (a frame without `web-share`) or a share without a user gesture.
        unavailable(`share: the browser does not allow sharing here (${err?.message ?? err})`);
      } else if (err?.name === "InvalidStateError") {
        // An earlier share's sheet is still open: a browser shows one at a
        // time and keeps it until the user closes it.
        unavailable(`share: the browser still shows an earlier share (${err?.message ?? err})`);
      } else {
        this.event(ROOT_ID, "onShare", { id: request, error: `share: ${err?.message ?? err}` });
      }
    }
  }

  // Audio (`Sound`, `AudioPlayer`) -----------------------------------------
  //
  // One `AudioContext` per runtime (an NSH engine: `reset` disposes it):
  // sounds are decoded into `AudioBuffer`s at load and played by an
  // `AudioBufferSourceNode` (+ a `GainNode`) per play; players are
  // `HTMLAudioElement`s. Browsers keep a context suspended and refuse
  // `play()` until the page's first user gesture: a sound played before it is
  // silence, a player's `play()` is `Failed { not-allowed }`.

  audioEvent(id, event, fields) {
    this.event(ROOT_ID, "onAudio", { id, event, ...fields });
  }

  audioState() {
    return (this.audio ??= { ctx: null, sounds: new Map(), voices: [], players: new Map(), unlock: null });
  }

  /** The context, made on first use; resumed by the page's first gesture. */
  audioContext() {
    const audio = this.audioState();
    if (audio.ctx) return audio.ctx;
    const Context = window.AudioContext ?? window.webkitAudioContext;
    if (typeof Context !== "function") return null;
    const ctx = (audio.ctx = new Context());
    const types = ["pointerdown", "keydown", "touchend", "click"];
    const unlock = () => {
      ctx.resume?.().then?.(() => {
        if (ctx.state === "running") release();
      }, () => {});
    };
    const release = () => {
      for (const type of types) window.removeEventListener(type, unlock, true);
      audio.unlock = null;
    };
    for (const type of types) window.addEventListener(type, unlock, { capture: true, passive: true });
    audio.unlock = release;
    return ctx;
  }

  audioBytesFromBase64(text) {
    const binary = atob(text);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
  }

  /** The bytes at `url` (`asset:/` or http(s)); past `maxBytes` is a quota error. */
  async audioFetch(url, maxBytes) {
    let response;
    try {
      response = await fetch(this.asset(url));
    } catch (err) {
      throw { code: "network", message: String(err?.message ?? err) };
    }
    if (!response.ok) throw { code: "network", message: `HTTP ${response.status}` };
    const length = Number(response.headers.get("content-length"));
    if (length > maxBytes) throw { code: "quota-exceeded", message: `${length} bytes (at most ${maxBytes})` };
    let bytes;
    try {
      bytes = await response.arrayBuffer();
    } catch (err) {
      throw { code: "network", message: String(err?.message ?? err) };
    }
    if (bytes.byteLength > maxBytes) {
      throw { code: "quota-exceeded", message: `${bytes.byteLength} bytes (at most ${maxBytes})` };
    }
    return bytes;
  }

  /** `AudioCommand::Load` / `LoadUrl`: decode what `source()` gives. */
  async audioLoad(id, source, maxDuration) {
    const audio = this.audioState();
    const entry = { buffer: null, voices: new Set() };
    audio.sounds.get(id)?.voices.forEach((voice) => this.audioEndVoice(voice));
    audio.sounds.set(id, entry);
    const fail = (error) => {
      if (audio.sounds.get(id) !== entry) return;
      audio.sounds.delete(id);
      this.audioEvent(id, "failed", { error: error?.code ?? "decode", message: String(error?.message ?? error ?? "") });
    };
    try {
      const ctx = this.audioContext();
      if (!ctx) return fail({ code: "unavailable", message: "no Web Audio" });
      const bytes = await source();
      if (audio.sounds.get(id) !== entry) return;
      let buffer;
      try {
        buffer = await ctx.decodeAudioData(bytes);
      } catch (err) {
        return fail({ code: "decode", message: String(err?.message ?? err ?? "undecodable audio") });
      }
      if (audio.sounds.get(id) !== entry) return;
      const truncated = buffer.duration > maxDuration;
      if (truncated) {
        // Only `maxDuration` of it is kept, as on the other platforms.
        const frames = Math.max(1, Math.floor(maxDuration * buffer.sampleRate));
        const short = ctx.createBuffer(buffer.numberOfChannels, frames, buffer.sampleRate);
        for (let c = 0; c < buffer.numberOfChannels; c++) {
          short.copyToChannel(buffer.getChannelData(c).subarray(0, frames), c);
        }
        buffer = short;
      }
      entry.buffer = buffer;
      this.audioEvent(id, "loaded", {
        duration: buffer.duration,
        bytes: buffer.length * buffer.numberOfChannels * 4,
        truncated,
      });
    } catch (err) {
      fail(err);
    }
  }

  audioEndVoice(voice) {
    const audio = this.audioState();
    audio.voices = audio.voices.filter((v) => v !== voice);
    voice.sound.voices.delete(voice);
    voice.src.onended = null;
    try { voice.src.stop(); } catch { /* not started or already stopped */ }
    try { voice.src.disconnect(); voice.gain.disconnect(); } catch { /* already */ }
  }

  audioPlay(id, volume, rate) {
    const audio = this.audioState();
    const sound = audio.sounds.get(id);
    const ctx = audio.ctx;
    // Before the first gesture the context is suspended: silence, not a sound
    // that starts late.
    if (!sound?.buffer || !ctx || ctx.state !== "running") return;
    // At most 32 voices at once: the oldest stops.
    while (audio.voices.length >= 32) this.audioEndVoice(audio.voices[0]);
    const src = ctx.createBufferSource();
    src.buffer = sound.buffer;
    src.playbackRate.value = rate;
    const gain = ctx.createGain();
    gain.gain.value = volume;
    src.connect(gain).connect(ctx.destination);
    const voice = { src, gain, sound };
    src.onended = () => this.audioEndVoice(voice);
    audio.voices.push(voice);
    sound.voices.add(voice);
    src.start();
  }

  audioStop(id) {
    this.audioState().sounds.get(id)?.voices.forEach((voice) => this.audioEndVoice(voice));
  }

  audioUnload(id) {
    const audio = this.audioState();
    this.audioStop(id);
    audio.sounds.delete(id);
  }

  playerOpen(id, src, settings) {
    const audio = this.audioState();
    audio.players.get(id) && this.playerClose(id);
    audio.players.set(id, { id, src, settings, el: null, failed: false, buffering: false, timer: 0, closed: false });
  }

  playerEmit(player, event, fields) {
    if (!player.closed) this.audioEvent(player.id, event, fields);
  }

  playerDuration(el) {
    return Number.isFinite(el.duration) ? el.duration : undefined;
  }

  playerProgress(player) {
    const el = player.el;
    if (!el) return;
    this.playerEmit(player, "progress", { position: el.currentTime, duration: this.playerDuration(el) });
  }

  playerStopTimer(player) {
    clearInterval(player.timer);
    player.timer = 0;
  }

  playerFail(player, error, message) {
    this.playerStopTimer(player);
    player.failed = true;
    this.playerEmit(player, "failed", { error, message });
  }

  /** The element of `player`, made (and loading) on first need. */
  playerElement(player) {
    if (player.el) return player.el;
    const el = (player.el = new Audio());
    el.preload = "auto";
    this.playerApply(player);
    const buffer = (on) => {
      if (player.buffering === on) return;
      player.buffering = on;
      this.playerEmit(player, "buffer", { buffering: on });
    };
    el.addEventListener("loadedmetadata", () =>
      this.playerEmit(player, "load", { duration: this.playerDuration(el) }));
    el.addEventListener("playing", () => {
      buffer(false);
      this.playerStopTimer(player);
      player.timer = setInterval(() => this.playerProgress(player), 250);
    });
    el.addEventListener("waiting", () => buffer(true));
    el.addEventListener("canplay", () => buffer(false));
    el.addEventListener("pause", () => {
      this.playerStopTimer(player);
      // The end pauses the element too: `ended` is what that reports.
      if (el.ended) return;
      this.playerProgress(player);
      this.playerEmit(player, "paused");
    });
    el.addEventListener("ended", () => {
      this.playerStopTimer(player);
      this.playerProgress(player);
      this.playerEmit(player, "ended");
    });
    el.addEventListener("error", () => {
      if (!el.getAttribute("src")) return;
      const http = /^https?:/i.test(player.src);
      this.playerFail(player, http ? "network" : "decode", el.error?.message || `media error ${el.error?.code}`);
    });
    el.src = this.asset(player.src);
    return el;
  }

  playerApply(player) {
    const el = player.el;
    if (!el) return;
    el.volume = Math.min(1, Math.max(0, player.settings.volume));
    el.playbackRate = player.settings.rate;
    el.loop = Boolean(player.settings.loop);
  }

  playerPreload(id) {
    const player = this.audioState().players.get(id);
    if (player) this.playerElement(player);
  }

  playerResume(id) {
    const player = this.audioState().players.get(id);
    if (!player) return;
    // After a failure, play again from a fresh load.
    if (player.failed && player.el) {
      player.failed = false;
      player.el.removeAttribute("src");
      player.el.load();
      player.el.src = this.asset(player.src);
    }
    player.failed = false;
    const el = this.playerElement(player);
    if (el.ended) el.currentTime = 0;
    el.play().then(() => {
      this.playerEmit(player, "playing");
    }, (err) => {
      // A `pause()` or a new load interrupts a pending `play()`: not a failure.
      if (err?.name === "AbortError") return;
      this.playerFail(
        player,
        err?.name === "NotAllowedError" ? "not-allowed" : err?.name === "NotSupportedError" ? "not-supported" : "failed",
        String(err?.message ?? err),
      );
    });
  }

  playerPause(id) {
    const player = this.audioState().players.get(id);
    if (!player) return;
    if (!player.el || player.el.paused) this.playerEmit(player, "paused");
    else player.el.pause();
  }

  playerSeek(id, position) {
    const player = this.audioState().players.get(id);
    if (!player) return;
    const el = this.playerElement(player);
    const duration = this.playerDuration(el);
    el.currentTime = duration === undefined ? position : Math.min(position, duration);
    this.playerProgress(player);
  }

  playerSet(id, settings) {
    const player = this.audioState().players.get(id);
    if (!player) return;
    player.settings = settings;
    this.playerApply(player);
  }

  playerClose(id) {
    const audio = this.audioState();
    const player = audio.players.get(id);
    if (!player) return;
    player.closed = true;
    this.playerStopTimer(player);
    audio.players.delete(id);
    const el = player.el;
    if (el) {
      el.pause();
      el.removeAttribute("src");
      el.load();
      player.el = null;
    }
  }

  /** Frees everything the audio of the engine that ran held (`reset`). */
  audioDispose() {
    const audio = this.audio;
    if (!audio) return;
    for (const id of [...audio.players.keys()]) this.playerClose(id);
    for (const voice of [...audio.voices]) this.audioEndVoice(voice);
    audio.sounds.clear();
    audio.unlock?.();
    audio.ctx?.close?.().catch?.(() => {});
    this.audio = null;
  }

  // `Notifications.permission` / `requestPermission`: `Notification`'s own
  // values. A browser refuses a prompt the user did not cause by answering
  // `default` or `denied`.
  async notificationPermission(request, ask) {
    let permission = window.Notification.permission;
    if (ask && permission === "default") {
      try {
        permission = await window.Notification.requestPermission();
      } catch (err) {
        console.warn(`[nsh] notifications: ${err}`);
      }
    }
    this.event(ROOT_ID, "onNotification", { id: request, permission });
  }

  // `Notifications.show`: replaces the one of the same id (`tag`). Android's
  // browsers have the class but throw: only a service worker shows there.
  showNotification(request, id, title, body, silent) {
    let shown = false;
    if (window.Notification.permission === "granted") {
      try {
        const notification = new window.Notification(title, { body, tag: id, silent });
        notification.onclick = () => {
          window.focus();
          notification.close();
          this.event(ROOT_ID, "onNotification", { pressed: id });
        };
        (this.notifications ??= new Map()).set(id, notification);
        shown = true;
      } catch (err) {
        console.warn(`[nsh] notifications: ${err}`);
      }
    }
    this.event(ROOT_ID, "onNotification", { id: request, shown });
  }

  // `Notifications.setBadge`: an installed web app's icon, where browsers
  // have the Badging API.
  setBadge(count) {
    const set = count > 0 ? navigator.setAppBadge?.(count) : navigator.clearAppBadge?.();
    set?.catch?.((err) => console.warn(`[nsh] setBadge: ${err}`));
  }

  // `openUrl` (the URL passed nsh_core::open_url's check): a web page in a
  // new tab, another scheme (mailto:, tel:, ...) through the browser's
  // handler. Whether the browser let it open (a blocked pop-up is false).
  openUrl(url) {
    let opened = null;
    try {
      opened = window.open(url, "_blank");
    } catch (err) {
      console.warn(`[nsh] openUrl: ${err}`);
    }
    // The page opened knows nothing of this one.
    if (opened) {
      try { opened.opener = null; } catch {}
    }
    return !!opened;
  }

  async readClipboard(request, hasOnly) {
    let text = "";
    try {
      text = (await navigator.clipboard?.readText()) ?? "";
    } catch {
      // Denied, or no clipboard access (an insecure context).
    }
    const payload = { id: request, has: text.length > 0 };
    if (!hasOnly && text) payload.text = text;
    this.event(ROOT_ID, "onClipboard", payload);
  }

  /**
   * `Clipboard.writeImage`: a `data:` URI's image as a clipboard item.
   * Browsers write images as PNG only, so another format is decoded and
   * encoded again. The write starts before that, with the PNG to come:
   * Safari only writes within the user's gesture, which an `await` loses.
   * The PNG holds a GIF's first frame only, so another format also goes on
   * as it is, as browsers' own Copy Image does: an `<img>` of it as HTML,
   * which pastes give the app, and in Chromium a `web ` format, which
   * `readClipboardImage` prefers.
   */
  writeClipboardImage(uri) {
    // Decoded here: the CSP of a page whose app restricts `network` keeps `fetch` from `data:` URIs.
    const base64 = /^data:([^;,]*);base64,/.exec(uri);
    const original = base64
      ? Promise.resolve().then(() => new Blob([this.audioBytesFromBase64(uri.slice(base64[0].length))], { type: base64[1] }))
      : fetch(uri).then((response) => response.blob());
    const png = (async () => {
      const blob = await original;
      if (blob.type === "image/png") return blob;
      const bitmap = await createImageBitmap(blob, { imageOrientation: "from-image" });
      try {
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        canvas.getContext("2d").drawImage(bitmap, 0, 0);
        return await canvas.convertToBlob({ type: "image/png" });
      } finally {
        bitmap.close();
      }
    })();
    const fail = (err) => console.warn(`[nsh] Clipboard.writeImage: ${err?.message ?? err}`);
    // Handled by the write; this keeps it from reporting twice when the write never starts.
    png.catch(() => {});
    try {
      const data = { "image/png": png };
      // The types go in now, before the image has loaded: `data:` URIs say theirs.
      const type = base64?.[1] ?? "";
      if (type !== "image/png") {
        const src = uri.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
        data["text/html"] = new Blob([`<img src="${src}">`], { type: "text/html" });
        if (type && ClipboardItem.supports?.(`web ${type}`)) data[`web ${type}`] = original;
      }
      return navigator.clipboard.write([new ClipboardItem(data)]).catch(fail);
    } catch (err) {
      // No clipboard (an insecure context) or no `ClipboardItem`.
      fail(err);
      return Promise.resolve();
    }
  }

  /**
   * `Picker.pickImages`: a file input of images. Files are read as they are,
   * unless one is larger than `maxDimension` (or a JPEG with a `quality`):
   * then it is drawn upright at the size that fits and encoded again (a PNG
   * stays a PNG), as `nsh_core::picker` says. A cancelled input sends none.
   */
  pickImages(request, limit, maxDimension, quality, current) {
    const app = this.app;
    const input = document.createElement("input");
    input.type = "file";
    input.accept = current ? "image/*" : "image/jpeg,image/png,image/gif,image/webp";
    input.multiple = limit > 1;
    input.style.display = "none";
    let answered = false;
    const answer = async (files) => {
      if (answered) return;
      answered = true;
      input.remove();
      const picked = [];
      for (const file of files.slice(0, limit)) {
        try {
          picked.push(await this.preparePicked(file, maxDimension, quality));
        } catch {
          // Unreadable: left out.
        }
      }
      if (app !== this.app) return;
      this.call((w) => {
        for (const p of picked) {
          this.withStrings([p.name, p.type, p.bytes], (np, nl, tp, tl, bp, bl) =>
            w.nsh_picked_file(np, nl, tp, tl, bp, bl, p.width, p.height, p.lastModified));
        }
        return w.nsh_picked(request);
      });
    };
    input.addEventListener("change", () => answer([...(input.files ?? [])]));
    input.addEventListener("cancel", () => answer([]));
    this.root.append(input);
    input.click();
  }

  /**
   * `Picker.pickFiles`: a file input offering `accept` (empty: any file). The
   * bytes and names stay as they are; a file larger than `maxBytes` is not
   * read (its `size` tells first): it answers with its name and size only.
   * A cancelled input sends none.
   */
  pickFiles(request, limit, accept, maxBytes) {
    const app = this.app;
    const input = document.createElement("input");
    input.type = "file";
    if (accept) input.accept = accept;
    input.multiple = limit > 1;
    input.style.display = "none";
    let answered = false;
    const answer = async (files) => {
      if (answered) return;
      answered = true;
      input.remove();
      const picked = [];
      for (const file of files.slice(0, limit)) {
        if (file.size > maxBytes) {
          console.warn(`nsh: the picked ${file.name} is not read: larger than ${maxBytes} bytes`);
          picked.push({ name: file.name, type: file.type, bytes: null, size: file.size, lastModified: file.lastModified });
          continue;
        }
        try {
          picked.push({
            name: file.name,
            type: file.type,
            bytes: new Uint8Array(await file.arrayBuffer()),
            lastModified: file.lastModified,
          });
        } catch {
          // Unreadable: left out.
        }
      }
      if (app !== this.app) return;
      this.call((w) => {
        for (const p of picked) {
          if (p.bytes === null) {
            this.withStrings([p.name, p.type], (np, nl, tp, tl) =>
              w.nsh_picked_too_large(np, nl, tp, tl, p.size, p.lastModified));
            continue;
          }
          this.withStrings([p.name, p.type, p.bytes], (np, nl, tp, tl, bp, bl) =>
            w.nsh_picked_file(np, nl, tp, tl, bp, bl, 0, 0, p.lastModified));
        }
        return w.nsh_picked(request);
      });
    };
    input.addEventListener("change", () => answer([...(input.files ?? [])]));
    input.addEventListener("cancel", () => answer([]));
    this.root.append(input);
    input.click();
  }

  async preparePicked(file, maxDimension, quality) {
    const type = file.type.toLowerCase();
    let bitmap = null;
    try {
      bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    } catch {
      // A format the browser does not decode: kept as it is.
    }
    const width = bitmap?.width ?? 0;
    const height = bitmap?.height ?? 0;
    const longer = Math.max(width, height);
    const scale = maxDimension > 0 && longer > maxDimension;
    const requality = quality >= 0 && type === "image/jpeg";
    const keep = { name: file.name, type, lastModified: file.lastModified, width, height };
    if (!bitmap || !(scale || requality)) {
      bitmap?.close();
      return { ...keep, bytes: new Uint8Array(await file.arrayBuffer()) };
    }
    const factor = scale ? maxDimension / longer : 1;
    const w = Math.max(1, Math.round(width * factor));
    const h = Math.max(1, Math.round(height * factor));
    const canvas = new OffscreenCanvas(w, h);
    canvas.getContext("2d").drawImage(bitmap, 0, 0, w, h);
    bitmap.close();
    const png = type === "image/png" && scale;
    const out = await canvas.convertToBlob(png ? { type: "image/png" } : { type: "image/jpeg", quality: quality >= 0 ? quality : 0.9 });
    const name = file.name.replace(/\.[^.]*$/, "") + (png ? ".png" : ".jpg");
    return { ...keep, name, type: out.type, width: w, height: h, bytes: new Uint8Array(await out.arrayBuffer()) };
  }

  /** `Clipboard.readImage` / `hasImage`: the first image item, as a `data:` URI with its size. */
  async readClipboardImage(request, hasOnly) {
    const app = this.app;
    const answer = (payload) => app === this.app && this.event(ROOT_ID, "onClipboard", { id: request, ...payload });
    let blob = null;
    try {
      for (const item of (await navigator.clipboard?.read()) ?? []) {
        // The original `writeClipboardImage` kept beside its PNG first.
        const type = item.types.find((t) => t.startsWith("web image/")) ?? item.types.find((t) => t.startsWith("image/"));
        if (type) {
          blob = await item.getType(type);
          if (type.startsWith("web ")) blob = new Blob([blob], { type: type.slice(4) });
          break;
        }
      }
    } catch {
      // Denied, or no clipboard access (an insecure context).
    }
    if (!blob || hasOnly) return answer({ has: !!blob });
    const uri = await new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(blob);
    });
    if (!uri) return answer({ has: true });
    const img = new Image();
    img.onload = () => answer({ has: true, uri, width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => answer({ has: true });
    img.src = uri;
  }

  /**
   * `nsh/host`'s `host.call`: `options.host.call(name, args)`, answered
   * with `onHost` `{ type: "reply" }` whatever happens (the app's call waits for the
   * reply): a missing host, a throw, a rejection or a result that is not
   * JSON answer `ok: false` with the error's message.
   */
  async hostCall(request, name, args) {
    // Answers for an app that was replaced meanwhile are dropped.
    const app = this.app;
    let reply;
    try {
      const host = this.options.host;
      if (typeof host?.call !== "function") throw new Error("this page has no host (createPlayer's `host`)");
      const value = (await host.call(name, args)) ?? null;
      reply = JSON.stringify({ type: "reply", id: request, ok: true, value });
    } catch (err) {
      reply = JSON.stringify({ type: "reply", id: request, ok: false, error: String(err?.message ?? err) });
    }
    if (app === this.app) this.eventJson(ROOT_ID, "onHost", reply);
  }

  /**
   * `nsh/host`'s `host.post`: `options.host.post(name, args)`, or its
   * `call(name, args)` when it has no `post`. Nothing goes back to the
   * app, so a throw, a rejection or a result is dropped.
   */
  hostPost(name, args) {
    const host = this.options.host;
    try {
      const done = typeof host?.post === "function" ? host.post(name, args) : host?.call?.(name, args);
      Promise.resolve(done).catch(() => {});
    } catch {}
  }

  /**
   * Sends `event` with `payload` to the app's `host.on(event)` listeners.
   * The payload is serialized here, so one that is not JSON throws to the
   * caller rather than inside a deferred engine call. Events sent before
   * the app runs wait for it (`begin`).
   */
  hostEvent(event, payload = null) {
    const json = JSON.stringify({ type: "event", event: String(event), payload: payload ?? null });
    if (this.started) this.eventJson(ROOT_ID, "onHost", json);
    else this.hostEvents?.push(json);
  }

  /** `Image.getSize` / `prefetch`: loads the image (the browser keeps it cached for the views that show it). */
  imageInfo(request, uri) {
    const img = new Image();
    // Answers for an app that was replaced meanwhile are dropped.
    const app = this.app;
    const answer = (payload) => app === this.app && this.event(ROOT_ID, "onImageInfo", { id: request, ...payload });
    img.onload = () => answer({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => answer({ error: `failed to load ${uri}` });
    this.setImageSource(img, uri, this.asset(uri));
  }

  // Network -------------------------------------------------------------

  /** A browser operation returns its error without reentering the engine. */
  /** Executes app-private fs/promises requests using persistent browser OPFS. */
  filesystemStart(id, request, bytes) {
    const token = {};
    this.fileOperations.set(id, token);
    const active = () => this.fileOperations.get(id) === token;
    const error = (code, message = code) => Object.assign(new Error(message), { code });
    const parts = (path) => {
      const value = path.split("/").filter(Boolean);
      if (value.some(p => p === "." || p === ".." || p.includes("\\"))) throw error("EACCES");
      return value;
    };
    const execute = async () => {
      if (!navigator.storage?.getDirectory) throw error("ERR_FEATURE_UNAVAILABLE_ON_PLATFORM", "This browser does not provide Origin Private File System storage");
      const origin = await navigator.storage.getDirectory();
      // Hashing makes arbitrary app IDs safe as a single OPFS directory name.
      const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(request.namespace));
      const namespace = Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, "0")).join("");
      const apps = await origin.getDirectoryHandle("nsh-files", {create:true});
      const root = await apps.getDirectoryHandle(namespace, {create:true});
      const directory = async (names, create = false) => {
        let dir = root;
        for (const name of names) dir = await dir.getDirectoryHandle(name, {create});
        return dir;
      };
      const locate = async (path) => {
        const names = parts(path);
        if (!names.length) return {handle:root, parent:root, name:""};
        const name = names.pop(), parent = await directory(names);
        let handle;
        try {handle = await parent.getFileHandle(name);} catch (e) {
          if (e.name !== "TypeMismatchError") throw e;
          handle = await parent.getDirectoryHandle(name);
        }
        return {handle,parent,name};
      };
      const names = parts(request.path), name = names.at(-1);
      if (!active()) return {};
      if (request.op === "mkdir") {
        if (!names.length) {if (!request.recursive) throw error("EEXIST"); return {};}
        if (request.recursive) {await directory(names,true); return {};}
        const parent = await directory(names.slice(0,-1));
        try {await locate(request.path); throw error("EEXIST");} catch(e) {if(e.name !== "NotFoundError") throw e;}
        await parent.getDirectoryHandle(name,{create:true}); return {};
      }
      if (request.op === "write") {
        if (!name) throw error("EISDIR");
        const parent = await directory(names.slice(0,-1));
        let handle;
        try {handle=await parent.getFileHandle(name,{create:true});} catch(e) {if(e.name === "TypeMismatchError") throw error("EISDIR");throw e;}
        if (!active()) return {};
        const writer = await handle.createWritable();
        try {
          if (!active()) {await writer.abort(); return {};}
          await writer.write(bytes);
          if (!active()) {await writer.abort(); return {};}
          await writer.close();
        } catch(e) {await writer.abort().catch(()=>{});throw e;}
        return {};
      }
      let item;
      try {item = await locate(request.path);} catch(e) {if(request.op === "exists" && e.name === "NotFoundError") return {kind:"exists",value:false}; throw e;}
      const {handle,parent} = item;
      const isDir = handle.kind === "directory";
      switch(request.op) {
        case "exists": return {kind:"exists",value:true};
        case "read": {
          if(isDir) throw error("EISDIR");
          const file=await handle.getFile();
          if(file.size > request.maxBytes) throw error("EFBIG", "File exceeds the configured read limit");
          return {kind:"bytes",bytes:new Uint8Array(await file.arrayBuffer())};
        }
        case "entries": {
          if(!isDir) throw error("ENOTDIR");
          const entries=[]; let nameBytes=0;
          for await (const [name,entry] of handle.entries()) {
            nameBytes += new TextEncoder().encode(name).length;
            if(entries.length >= request.maxEntries || nameBytes > request.maxNameBytes) throw error("EFBIG", "Directory exceeds the configured listing limit");
            entries.push({name,directory:entry.kind === "directory"});
          }
          return {kind:"entries",entries};
        }
        case "stat": {
          const file=isDir?null:await handle.getFile();
          return {kind:"metadata",file:!isDir,directory:isDir,size:file?.size??0,mtime:file?.lastModified??0};
        }
        case "readlink": throw error("EINVAL", "OPFS entries are regular files and directories");
        case "unlink": if(isDir) throw error("EISDIR"); if (!active()) return {}; await parent.removeEntry(item.name); return {};
        case "rmdir":
          if(!isDir) throw error("ENOTDIR");
          if(!item.name) throw error("EBUSY");
          for await (const _ of handle.keys()) throw error("ENOTEMPTY");
          if (!active()) return {};
          await parent.removeEntry(item.name); return {};
        case "rename": {
          const to=parts(request.to), targetName=to.pop();
          if(!item.name || !targetName) throw error("EBUSY");
          const target=await directory(to);
          if(await parent.isSameEntry(target) && item.name===targetName) return {};
          try {
            const existing = (await locate(request.to)).handle;
            if(existing.kind === "directory" && !isDir) throw error("EISDIR");
            if(existing.kind === "file" && isDir) throw error("ENOTDIR");
            if(existing.kind === "directory") {
              for await (const _ of existing.keys()) throw error("ENOTEMPTY");
            }
          } catch(e) {if(e.name !== "NotFoundError") throw e;}
          if(typeof handle.move !== "function") throw error("ENOTSUP", "This browser does not support atomic OPFS rename for this entry");
          // The browser's move preserves a file's identity; never emulate it with copy/delete.
          if (!active()) return {};
          await handle.move(target,targetName); return {};
        }
        default: throw error("ENOTSUP");
      }
    };
    execute().then(result => {
      if(!active()) return;
      const bytes=result.bytes??new Uint8Array(); delete result.bytes;
      this.call(w => this.withStrings([JSON.stringify(result),bytes], (p,l,bp,bl) => w.nsh_filesystem_reply(id,p,l,bp,bl)));
      this.fileOperations.delete(id);
    }, e => {
      if(!active()) return;
      const codes={NotFoundError:"ENOENT",TypeMismatchError:"ENOTDIR",NotAllowedError:"EACCES",SecurityError:"EACCES",QuotaExceededError:"ENOSPC",InvalidModificationError:"ENOTEMPTY",NotSupportedError:"ENOTSUP"};
      const reply={error:String(e?.message??e),code:e?.code&&typeof e.code === "string"?e.code:(codes[e?.name]??"EIO"),syscall:request.op,path:request.path};
      this.call(w => this.withStrings([JSON.stringify(reply),new Uint8Array()], (p,l,bp,bl) => w.nsh_filesystem_reply(id,p,l,bp,bl)));
      this.fileOperations.delete(id);
    });
  }

  websocketOperation(operation) {
    try {
      operation();
      return 1;
    } catch (error) {
      this.withStrings([String(error?.message ?? error)], (p, l) => this.wasm.nsh_websocket_reply(p, l));
      return 0;
    }
  }

  websocketStart(id, request) {
    const socket = new WebSocket(request.url, request.protocols);
    socket.binaryType = "arraybuffer";
    this.websockets.set(id, socket);
    const report = (kind, value, code = 0, clean = false) => {
      if (this.websockets.get(id) !== socket) return;
      this.call((w) => {
        // A queued callback from before stop or a hot replacement cannot enter the new engine.
        if (this.websockets.get(id) !== socket) return w.nsh_pump();
        // Count UTF-8 without allocating an encoded copy of an oversized peer message.
        const limit = 8 * 1024 * 1024;
        let length = typeof value === "string" ? 0 : value.byteLength;
        if (typeof value === "string") {
          for (let i = 0; i < value.length && length <= limit; i++) {
            const ch = value.charCodeAt(i);
            if (ch < 0x80) length++;
            else if (ch < 0x800) length += 2;
            else if (ch >= 0xd800 && ch <= 0xdbff && i + 1 < value.length &&
              value.charCodeAt(i + 1) >= 0xdc00 && value.charCodeAt(i + 1) <= 0xdfff) {
              length += 4;
              i++;
            } else length += 3;
          }
        }
        if (length > limit) {
          const message = "WebSocket message exceeds the 8 MiB limit";
          return this.withStrings([message], (p, l) => {
            try {
              w.nsh_websocket_event(id, 3, p, l, 0, 0);
              return w.nsh_websocket_event(id, 4, p, l, 1009, 0);
            } finally { this.websocketCancel(id); }
          });
        }
        return this.withStrings([value], (p, l) => w.nsh_websocket_event(id, kind, p, l, code, clean ? 1 : 0));
      });
    };
    // The browser's WebSocket has no flow control: while the app's unread
    // messages fill their queue (`websocket_pause`), the socket's events
    // wait here, in order, outside the engine's memory.
    const hold = { paused: false, events: [], report };
    socket.nshHold = hold;
    const deliver = (...event) => {
      if (hold.paused || hold.events.length) hold.events.push(event);
      else report(...event);
    };
    socket.onopen = () => deliver(0, socket.protocol);
    socket.onmessage = (event) => deliver(typeof event.data === "string" ? 1 : 2,
      typeof event.data === "string" ? event.data : new Uint8Array(event.data));
    socket.onerror = () => deliver(3, "Browser WebSocket failed (network, TLS, origin or server handshake error)");
    socket.onclose = (event) => deliver(4, event.reason, event.code, event.wasClean);
  }

  /** Holds (`paused`) or delivers again the events of socket `id`. */
  websocketPause(id, paused) {
    const socket = this.websockets.get(id);
    const hold = socket?.nshHold;
    if (!hold) return;
    hold.paused = paused;
    if (paused || !hold.events.length) return;
    // The engine resumes from inside a call: the held events enter it in a
    // task of their own, one at a time, until it pauses the socket again.
    setTimeout(() => {
      while (!hold.paused && hold.events.length && this.websockets.get(id) === socket) {
        hold.report(...hold.events.shift());
      }
    });
  }

  websocketCancel(id) {
    const socket = this.websockets.get(id);
    if (!socket) return;
    this.websockets.delete(id);
    socket.onopen = socket.onmessage = socket.onerror = socket.onclose = null;
    try { socket.close(); } catch { /* The browser already ended this socket. */ }
  }

  /**
   * Request `id` from the engine's `fetch` (`net.rs`): made with the
   * browser's `fetch`, its head and body chunks reported back as they come.
   * A streamed body (`streamed`) is collected until `fetch_finish`.
   */
  fetchStart(id, method, url, headers, body, streamed, follow, cache) {
    const request = { controller: new AbortController(), paused: false, resume: null, reader: null, done: false };
    this.requests.set(id, request);
    const report = (f) => {
      if (this.requests.get(id) === request) this.call(f);
    };
    const fail = (message) => {
      report((w) => this.withStrings([message], (p, l) => w.nsh_fetch_failed(id, p, l)));
      this.requests.delete(id);
    };
    const send = async (body) => {
      const init = { method, headers: new Headers(), body, redirect: follow ? "follow" : "manual", cache: cache || "default", signal: request.controller.signal };
      for (const [name, value] of headers) {
        try {
          init.headers.append(name, value);
        } catch {
          // A name or value the browser refuses.
        }
      }
      let response;
      try {
        response = await fetch(url, init);
      } catch (e) {
        if (request.controller.signal.aborted) return;
        fail(`fetch ${method} ${url} failed: ${e?.message ?? e} (a network error, or a cross-origin server that does not allow this page's origin)`);
        return;
      }
      if (response.type === "opaqueredirect") {
        // Browsers hide a redirect that is not followed: neither its status
        // nor its Location can be delivered (`redirect: "manual"`) or
        // checked against the app's capabilities before the next hop.
        fail(`fetch ${method} ${url} was redirected: on the web a redirect is only followed by the browser, not delivered or checked hop by hop`);
        return;
      }
      const list = [];
      response.headers.forEach((value, name) => list.push([name, value]));
      report((w) => this.withStrings([response.url || url, response.statusText, JSON.stringify(list)], (up, ul, tp, tl, hp, hl) =>
        w.nsh_fetch_head(id, response.status, up, ul, tp, tl, hp, hl, response.redirected ? 1 : 0)));
      if (!response.body) {
        report((w) => w.nsh_fetch_end(id));
        this.requests.delete(id);
        return;
      }
      request.reader = response.body.getReader();
      try {
        for (;;) {
          while (request.paused) await new Promise((resolve) => (request.resume = resolve));
          if (this.requests.get(id) !== request) return;
          const { done, value } = await request.reader.read();
          if (done) break;
          report((w) => this.withStrings([value], (p, l) => w.nsh_fetch_data(id, p, l)));
        }
      } catch (e) {
        if (!request.controller.signal.aborted) fail(`fetch ${method} ${url}: the body broke off: ${e?.message ?? e}`);
        return;
      }
      report((w) => w.nsh_fetch_end(id));
      this.requests.delete(id);
    };
    if (streamed) {
      // Chromium streams uploads only over HTTP/2, other browsers not at
      // all: the chunks are collected and sent as one body.
      request.chunks = [];
      request.wanted = () => report((w) => w.nsh_fetch_body_wanted(id));
      request.finish = () => {
        const chunks = request.chunks;
        request.chunks = null;
        if (chunks) send(new Blob(chunks));
      };
      request.wanted();
    } else {
      send(body ?? undefined);
    }
  }

  fetchSend(id, chunk) {
    const request = this.requests.get(id);
    if (!request?.chunks) return;
    request.chunks.push(chunk);
    request.wanted();
  }

  fetchPause(id, paused) {
    const request = this.requests.get(id);
    if (!request) return;
    request.paused = paused;
    if (!paused && request.resume) {
      request.resume();
      request.resume = null;
    }
  }

  fetchCancel(id) {
    const request = this.requests.get(id);
    if (!request) return;
    this.requests.delete(id);
    request.controller.abort();
    request.resume?.();
  }

  /**
   * `Alert.alert` / action sheets, drawn inside the surface: with the
   * desktop idiom as the Linux and macOS backends' cards (up to three
   * buttons in a row, the last regular one the default), otherwise as
   * iOS's alert and action sheet. Answers the button's index, -1 when
   * dismissed (a click beside it, or Escape, when cancelable); Escape
   * presses the cancel button if any (`keyDown`, `_cancel`). An alert with
   * `input` (not null) has a text field starting with it, focused, its
   * text answered as `value`: Enter in it presses the default button, and
   * while a `required` field is empty only the cancel buttons are enabled.
   */
  dialog(dialogId, title, message, buttons, styles, cancelable, sheet, input = null, placeholder = null,
    selectAll = false, required = false) {
    // `AlertDialog` always brings the app's actions: no label of NSH's own.
    const list = buttons;
    const style = (i) => styles[i] ?? "default";
    const desktop = this.desktopUI;
    const backdrop = document.createElement("div");
    backdrop.className = sheet ? "nsh-dialog-backdrop nsh-sheet-backdrop" : "nsh-dialog-backdrop";
    const focused = document.activeElement;
    const restore = focused !== document.body && this.root.contains(focused) ? focused : null;
    let answered = false;
    // A tap's compatibility click lands after the press that opened the
    // dialog: only clicks pressed inside it (or from the keyboard) count.
    let down = null;
    backdrop.addEventListener("pointerdown", (e) => { down = e.target; }, true);
    const pressed = (e, el) => e.detail === 0 || (down !== null && el.contains(down));
    // Off the surface, once: false when it was already.
    const takeDown = () => {
      if (answered) return false;
      answered = true;
      backdrop.remove();
      this.releaseFrame(backdrop);
      this.dialogs = this.dialogs.filter((d) => d !== backdrop);
      this.scopeFocus();
      if (restore?.isConnected) restore.focus({ preventScroll: true });
      return true;
    };
    let field = null;
    const close = (index) => {
      if (!takeDown()) return;
      this.event(ROOT_ID, "onDialog", field ? { id: dialogId, index, value: field.value } : { id: dialogId, index });
    };
    backdrop._dialogId = dialogId;
    backdrop._takeDown = takeDown;
    const cancel = list.findIndex((_, i) => style(i) === "cancel");
    backdrop._cancel = () => (cancel >= 0 ? close(cancel) : cancelable && close(-1));
    const button = (index) => {
      const b = document.createElement("button");
      b.textContent = list[index];
      if (style(index) !== "default") b.classList.add(style(index));
      b.addEventListener("click", (e) => pressed(e, b) && close(index));
      return b;
    };
    let focus = null;
    const box = document.createElement("div");
    box.setAttribute("role", "alertdialog");
    box.setAttribute("aria-modal", "true");
    box.setAttribute("aria-label", title ?? message ?? "");
    if (sheet) {
      box.className = "nsh-sheet";
      const options = document.createElement("div");
      if (title || message) {
        const head = document.createElement("div");
        head.className = "nsh-sheet-head";
        if (title) {
          const b = document.createElement("b");
          b.textContent = title;
          head.append(b);
        }
        if (message) head.append(message);
        options.append(head);
      }
      list.forEach((_, i) => {
        if (i === cancel) return;
        const b = button(i);
        focus ??= b;
        options.append(b);
      });
      if (options.firstChild) box.append(options);
      if (cancel >= 0) {
        const card = document.createElement("div");
        const b = button(cancel);
        focus ??= b;
        card.append(b);
        box.append(card);
      }
    } else {
      box.className = "nsh-dialog";
      if (title) {
        const h = document.createElement("h3");
        h.textContent = title;
        box.append(h);
      }
      if (message) {
        const p = document.createElement("p");
        p.textContent = message;
        box.append(p);
      }
      if (input !== null) {
        field = document.createElement("input");
        field.type = "text";
        field.className = "nsh-dialog-input";
        field.value = input;
        if (placeholder !== null) field.placeholder = placeholder;
        field.setAttribute("aria-label", title ?? message ?? placeholder ?? "");
        box.append(field);
      }
      const actions = document.createElement("div");
      // Desktop: up to three in a row; iOS: two side by side.
      const row = desktop ? list.length <= 3 : list.length === 2;
      actions.className = `nsh-dialog-actions ${row ? "row" : "column"}`;
      // The last regular button is the default action (Return).
      let preferred = -1;
      for (let i = list.length - 1; i >= 0 && preferred < 0; i--) if (style(i) === "default") preferred = i;
      list.forEach((_, i) => {
        const b = button(i);
        if (i === preferred) {
          if (desktop) b.classList.add("default");
          focus = b;
        }
        actions.append(b);
      });
      focus ??= actions.firstChild;
      box.append(actions);
      if (field) {
        const all = [...actions.children];
        const enable = () => {
          if (!required) return;
          const empty = field.value === "";
          all.forEach((b, i) => { b.disabled = empty && style(i) !== "cancel"; });
        };
        enable();
        field.addEventListener("input", enable);
        field.addEventListener("keydown", (e) => {
          if (e.key !== "Enter" || e.isComposing) return;
          e.preventDefault();
          const b = all[preferred];
          if (b && !b.disabled) close(preferred);
        });
        focus = field;
      }
    }
    backdrop.addEventListener("click", (e) => e.target === backdrop && down === backdrop && cancelable && close(-1));
    backdrop.append(box);
    this.root.append(backdrop);
    if (this.viewportDialogs) this.raise(backdrop);
    (this.dialogs ??= []).push(backdrop);
    this.scopeFocus();
    focus?.focus({ preventScroll: true });
    if (field) {
      if (selectAll) field.select();
      else field.setSelectionRange(field.value.length, field.value.length);
    }
  }

  /** Takes back the dialog `dialog` showed as `dialogId` (`closeDialog`), reporting nothing: the core answered it. */
  closeDialog(dialogId) {
    this.dialogs?.find((d) => d._dialogId === dialogId)?._takeDown();
  }

  /** Dialogs and other system UI look as the desktop backends' with the desktop idiom, else as on phones. */
  get desktopUI() {
    return this.idiom === "desktop";
  }

  /** Classes system UI (dialogs, spinners) styles itself with. */
  updateRootClasses() {
    this.root.classList.toggle("nsh-dark", this.shownDark);
    this.root.classList.toggle("nsh-desktop", this.desktopUI);
    this.root.classList.toggle("nsh-reduce", this.reduceMotion());
  }

  /** The user asked for less motion (`Environment::reduce_motion`). */
  reduceMotion() {
    return !!this.reducedMotion?.matches;
  }

  /** Registered native components are the native apps' own: the web has none, so the box stays empty (said once per name). */
  op_comp([, , name]) {
    if (this.missingComponents?.has(name)) return;
    (this.missingComponents ??= new Set()).add(name);
    const message = `native component "${name}" is not available on the web: its view stays empty`;
    console.warn("[nsh]", message);
    this.options.onLog?.("warn", message);
  }

  // Input ---------------------------------------------------------------

  /** The view element an event target is in. */
  viewOf(target) {
    let el = target;
    while (el && el !== this.root && el._id === undefined) el = el.parentNode;
    return el && el._id !== undefined ? el : null;
  }

  ancestors(el) {
    const out = [];
    for (let e = el; e && e !== this.root.parentNode; e = e.parentNode) if (e._id !== undefined) out.push(e);
    return out;
  }

  /** Convert viewport coordinates through the view's composed 2D transforms. */
  mousePoint(el, e) {
    let a = 1, b = 0, c = 0, d = 1;
    for (let node = el; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.transform !== "none") {
        const m = new DOMMatrix(style.transform);
        [a, b, c, d] = [m.a * a + m.c * b, m.b * a + m.d * b,
          m.a * c + m.c * d, m.b * c + m.d * d];
      }
      // `scale` applies after `transform` (a layer at the app's scale,
      // `scaleLayer`).
      if (style.scale && style.scale !== "none") {
        const [sx, sy = sx] = style.scale.split(" ").map(Number);
        [a, b, c, d] = [sx * a, sy * b, sx * c, sy * d];
      }
      // Top-layer views ignore their DOM ancestors' transforms (including
      // the preserved app scale inside an elevated iframe).
      if (node.classList?.contains("nsh-viewport")) break;
    }
    const r = el.getBoundingClientRect();
    const det = a * d - b * c;
    if (!det) return null;
    const style = getComputedStyle(el);
    const w = parseFloat(style.width), h = parseFloat(style.height);
    // The bounding rectangle includes transform origins and scrolling;
    // its top left is the minimum of the transformed border-box corners.
    const x = e.clientX - r.left + Math.min(0, a * w, c * h, a * w + c * h);
    const y = e.clientY - r.top + Math.min(0, b * w, d * h, b * w + d * h);
    return [(d * x - c * y) / det, (a * y - b * x) / det];
  }

  /**
   * `onMouseMove` of the views under the mouse and the views they are in
   * (inside out), with or without a button down. Mouse motion follows the
   * hit view, even during pointer capture. The engine keeps the latest
   * per view for the frame.
   */
  mouseMoved(e) {
    if (e.pointerType !== "mouse" || !this.mouseTracked.size) return;
    const target = document.elementFromPoint(e.clientX, e.clientY);
    if (!target || !this.root.contains(target)) return;
    for (const el of this.ancestors(this.viewOf(target))) {
      if (!el._events?.has("onMouseMove")) continue;
      const payload = this.mouseEvent(el, e);
      if (payload) this.event(el._id, "onMouseMove", payload);
    }
  }

  /**
   * `onMouseUp` of the views under the mouse and the views they are in
   * (inside out), with the button released. A `pointercancel` releases
   * nothing.
   */
  mouseUp(e) {
    // A `button` this build cannot name is no release to report: the engine
    // drops such a payload too, and a real mouse only reports 0-4.
    const button = MOUSE_BUTTON_NAMES[e.button];
    if (!button) return;
    const target = document.elementFromPoint(e.clientX, e.clientY);
    if (!target || !this.root.contains(target)) return;
    for (const el of this.ancestors(this.viewOf(target))) {
      if (!el._events?.has("onMouseUp")) continue;
      const payload = this.mouseEvent(el, e);
      if (!payload) continue;
      payload.button = button;
      this.event(el._id, "onMouseUp", payload);
    }
  }

  installInput() {
    const root = this.root;
    this.installFileDrop(root);
    // What the user gives input with, told before it acts (the capture
    // phase, ahead of the app's handlers and the browser's focus moves):
    // the core shows the focus by it (`focus-visible:`), as the browser
    // decides `:focus-visible`. Only a change crosses to the engine.
    root.addEventListener("pointerdown", () => this.inputWith(1), true);
    window.addEventListener("keydown", (e) => MODALITY_KEYS_SKIPPED.has(e.key) || this.inputWith(0), true);
    root.addEventListener("pointerdown", (e) => this.pointerDown(e));
    // A responder that blocks native scrolling (`setResponder`, a
    // `TouchClaim`'s `block_native`) keeps its touches: the browser would
    // scroll the scroll view around it and cancel them. One the browser
    // already scrolls (`cancelable` false) stays the browser's, as a
    // native scroll view that started dragging first takes them over.
    root.addEventListener("touchmove", (e) => {
      if (this.responderBlocks && e.cancelable) e.preventDefault();
    }, { passive: false });
    // A link (`Link` with an `href`) is the app's to press: a plain click
    // stays in the app (its `onPress`), a click with a modifier or the
    // middle button opens its `href` as the browser would, and the link
    // takes no press then (`pointerDown`).
    root.addEventListener("click", (e) => {
      const link = e.target instanceof Element ? e.target.closest(LINK_SELECTOR) : null;
      if (link && e.button === 0 && !heldModifier(e)) e.preventDefault();
    });
    window.addEventListener("pointermove", (e) => this.pointerMove(e), { passive: false });
    window.addEventListener("pointerup", (e) => this.pointerUp(e, false));
    window.addEventListener("pointercancel", (e) => this.pointerUp(e, true));
    window.addEventListener("blur", () => {
      this.hoverButtons = 0;
      for (const [pointerId, p] of [...this.pointers]) {
        p.scrolls = null;
        this.pointerUp({ pointerId, buttons: 0 }, true);
      }
    });
    // A drag never drags images or text out of the app.
    root.addEventListener("dragstart", (e) => e.preventDefault());
    root.addEventListener("mousedown", (e) => this.mouseDown(e));
    // No page menu over the app (nor iOS's callout on a long press); fields
    // and selectable text keep theirs.
    root.addEventListener("contextmenu", (e) => this.contextMenu(e) || this.editable(e.target) || e.preventDefault());
    root.addEventListener("copy", (e) => this.copyText(e));
    // A selectable view's `onSelectionChange`: what a copy would give.
    document.addEventListener("selectionchange", () => this.areaSelectionChanged());
    root.addEventListener("wheel", (e) => this.wheel(e), { passive: false });
    // Safari's touchpad pinches (it sends no ctrl+wheel).
    root.addEventListener("gesturestart", (e) => this.pinchEvent(e, 0) || this.gestureZoom(e, 0));
    root.addEventListener("gesturechange", (e) => this.pinchEvent(e, 1) || (this.gesture && this.gestureZoom(e, 1)));
    root.addEventListener("gestureend", (e) => this.pinchEvent(e, 2) || (this.gesture && this.gestureZoom(e, 2)));
    root.addEventListener("pointermove", (e) => {
      this.mouseMoved(e);
      if (e.pointerType !== "mouse") return;
      // A button released while another is still held comes as a move
      // that names it (`pointerup` is only the last button's release).
      if (e.button >= 0 && !(e.buttons & MOUSE_BUTTON_BITS[e.button])) this.mouseUp(e);
      this.hover = [e.clientX, e.clientY];
      this.hoverButtons = e.buttons;
      // Reveal only a draggable thumb under the pointer.
      if (!this.desktopUI || e.buttons) return;
      const view = this.viewOf(e.target);
      if (view) for (const el of this.ancestors(view)) if (el._kind === "scroll") this.hoverBar(el, e);
    });
    root.addEventListener("focusin", () => (Player.active = this));
    window.addEventListener("keydown", (e) => this.keyDown(e));
    window.addEventListener("keyup", (e) => this.keyUp(e));
    // The mouse's back button goes back in the app (with history, as the
    // browser's back button does).
    root.addEventListener("mouseup", (e) => {
      if (e.button !== 3 || this.history) return;
      e.preventDefault();
      this.back();
    });
    this.live = document.createElement("div");
    this.live.className = "nsh-live";
    this.live.setAttribute("aria-live", "polite");
    if (this.history) this.installHistory();
  }

  /**
   * `onContextMenu` of the nearest view around `e`'s target that listens,
   * unless a field or selectable text is nearer (it keeps the browser's
   * menu); true when a view took it. The browser raises `contextmenu` for
   * pointer gestures and accessibility actions. `keyDown` handles the Menu
   * key and Shift+F10 too: Chromium on macOS does not raise that event for
   * them. Keyboard requests name no pointer and start at the view's
   * bottom-start corner.
   */
  contextMenu(e, keyboard = false) {
    const view = this.viewOf(e.target);
    if (!view) return false;
    for (const el of this.ancestors(view)) {
      if (el._events?.has("onContextMenu")) {
        e.preventDefault();
        const r = el.getBoundingClientRect();
        // Chromium can name a mouse for keyboard context menus, but no
        // button (-1). Older MouseEvents without pointerType are mouse input.
        const pointerType = keyboard || e.button === -1 ? null : e.pointerType === undefined ? "mouse" : e.pointerType || null;
        let at = e;
        if (pointerType === null) {
          const rtl = getComputedStyle(el).direction === "rtl";
          at = { clientX: rtl ? r.right : r.left, clientY: r.bottom, target: e.target };
        }
        const [pageX, pageY] = this.point(at);
        this.event(el._id, "onContextMenu", {
          position: { x: at.clientX - r.left, y: at.clientY - r.top },
          pagePosition: { x: pageX, y: pageY },
          modifiers: { control: e.ctrlKey, alt: e.altKey, shift: e.shiftKey, platform: e.metaKey },
          pointerType: ["mouse", "pen", "touch"].includes(pointerType) ? pointerType : pointerType && "mouse",
        });
        return true;
      }
      // A link (`Link` with an `href`) the app shows no menu for has
      // the browser's: open in a new tab, copy the link.
      if (el.localName === "a" && el.hasAttribute("href")) return true;
      if (el.matches(".nsh-field, .nsh-selectable")) return false;
    }
    return false;
  }

  /** Whether the browser handles presses at `target` itself: fields,
   * selectable text, hosted pages and videos. */
  editable(target) {
    return !!target?.closest?.(".nsh-field, .nsh-selectable, iframe, video") || !!this.textAt(target) || this.areaGap(target);
  }

  /** Whether `target` is in a selectable view outside its texts, where a
   * drag starts a selection as between a web page's paragraphs: not in a
   * view inside the area that takes presses (they keep theirs) nor in a
   * text set off. */
  areaGap(target) {
    const area = target?.closest?.(".nsh-area");
    if (!area || target.closest(".nsh-noselect")) return false;
    const press = target.closest(".nsh-press");
    return !press || !area.contains(press);
  }

  /** The text at `target` that is selectable by default: not set off, and
   * in a selectable view, or (desktop idiom) in nothing that takes presses
   * or touches. */
  textAt(target) {
    const text = target?.closest?.(".nsh-autoselect");
    if (!text) return null;
    if (text.closest(".nsh-area")) return text;
    return this.desktopUI && !text.closest(".nsh-press") ? text : null;
  }

  /** The selectable view `el` is in: the outermost, as an area inside
   * another is part of it. */
  areaOf(el) {
    let area = null;
    for (let a = el?.closest?.(".nsh-area"); a; a = a.parentElement?.closest(".nsh-area")) area = a;
    return area;
  }

  /** This player takes the keys: the focus is in it, or it was the last
   * one used and the focus is on no element. */
  takesKeys() {
    const focus = document.activeElement;
    if (focus && focus !== document.body) return this.root.contains(focus);
    return (Player.active ?? this) === this;
  }

  // Keyboard

  /**
   * A modifier key went down or up while the mouse rests over the page
   * with no button down: the hovered views that listen hear
   * `onMouseMove` again where it is, with the modifiers as they are now
   * (an editor underlines a definition while Mod is held), as they would
   * on the next move.
   */
  modifiersChanged(e) {
    if (!MOUSE_MODIFIER_KEYS.has(e.key) || e.repeat || !this.hover || this.hoverButtons || !this.mouseTracked.size) return;
    const [x, y] = this.hover;
    const target = document.elementFromPoint(x, y);
    if (!target || !this.root.contains(target)) return;
    // The mouse where it rests, with the keys as they are now; its target
    // says which root view's coordinates its page position is in.
    const at = { target, clientX: x, clientY: y, buttons: 0, ctrlKey: e.ctrlKey, altKey: e.altKey, shiftKey: e.shiftKey, metaKey: e.metaKey };
    for (const el of this.ancestors(this.viewOf(target))) {
      if (!el._hoverIn || !el._events?.has("onMouseMove")) continue;
      const payload = this.mouseEvent(el, at);
      if (payload) this.event(el._id, "onMouseMove", payload);
    }
  }

  /** Whether `view` or an enabled logical ancestor hears raw keys
   * (`onKeyDown` / `onKeyUp`) or captures them (`captureKeys`), from the
   * core's own tree: an overlay's content is that tree's, whatever its DOM
   * ancestry. Only then does a transition need a `KeyEvent`. Cheap, and
   * without allocation. */
  keyInterest(view) {
    return this.wasm?.nsh_key_interest?.(view._id) > 0;
  }

  /**
   * Reports a raw key transition on `view` to the core, which decides with
   * the mounted capture rules of it and its enabled ancestors and routes
   * one event to the view and its ancestors (no duplicates here): true
   * when the policy captured the key, so the browser's default does not
   * run. The event carries what the browser reported — `e.key` as its
   * logical key (its actual case and layout) and the DOM's own `e.code`
   * (`KeyA`, `ArrowLeft`; empty when the browser names none) — never a
   * US-layout guess, and never derived from the logical key. `stroke` is
   * the page's canonical shortcut key (`keyCode(e)`), the one `nsh_key`
   * matches and `captureKeys` names: not a layout guess from the code.
   */
  rawKey(view, down, e, stroke) {
    if (!this.wasm?.nsh_key_event) return false;
    // An input method owns a composing key (some browsers report 229 rather
    // than `isComposing`): the raw key is not the app's.
    if (e.isComposing || e.keyCode === 229) return false;
    const key = typeof e.key === "string" && e.key !== "" ? e.key : "Unidentified";
    const code = typeof e.code === "string" ? e.code : "";
    const modifiers = (e.ctrlKey ? 1 : 0) | (e.altKey ? 2 : 0) | (e.shiftKey ? 4 : 0) | (e.metaKey ? 8 : 0);
    let captured = false;
    // The event's entry into the engine returns the pump delay, as every
    // entry does; the capture answer of that transition comes separately.
    this.call(() => {
      const delay = this.withStrings([key, code], (kp, kl, cp, cl) =>
        this.wasm.nsh_key_event(view._id, down ? 1 : 0, stroke, kp, kl, cp, cl,
          modifiers, e.repeat ? 1 : 0));
      captured = this.wasm.nsh_key_captured?.() > 0;
      return delay;
    });
    return captured;
  }

  /** The view that holds the keyboard focus in this player, when it is a
   * view of the app's and not a native field, page or video, which keeps
   * its own keys. With nothing focused (the page's body, or the root),
   * the window's root hears the keys, as `document.body` does: the newest
   * modal's root while one is presented. A system dialog keeps its keys. */
  keyFocusView() {
    const focus = document.activeElement;
    if (!focus || focus === document.body || focus === this.root) {
      if (this.dialogs?.length) return null;
      return this.topModal() ?? this.root;
    }
    if (!this.root.contains(focus)) return null;
    if (focus.isContentEditable || focus.closest?.(".nsh-field, [contenteditable], iframe, video")) return null;
    return this.viewOf(focus);
  }

  /**
   * The app's shortcut (`nsh/keymap`) key `e` fires, matched natively
   * against the mounted table: its binding, -2 for a held key whose binding
   * does not repeat, -1 for none, `-3 - id` for binding `id` that passes the
   * key through (reported, then the key goes on). `control`: a control
   * that Return and Space press has the focus, so they fire only the
   * focus' own bindings (`Keymap::find_at`).
   */
  shortcut(e, editing, control = false) {
    const code = e.isComposing ? -1 : keyCode(e);
    if (code < 0) return -1;
    const mods = (e.ctrlKey ? 1 : 0) | (e.altKey ? 2 : 0) | (e.shiftKey ? 4 : 0) | (e.metaKey ? 8 : 0);
    return this.wasm.nsh_key(code, mods, (editing ? 1 : 0) | (control ? 2 : 0), e.repeat ? 1 : 0);
  }

  keyDown(e) {
    if (this.wasm) this.modifiersChanged(e);
    if (!this.wasm || !this.takesKeys()) return;
    // Where the key was pressed, not where the focus is by now: a field's
    // own handler (its submit, its Escape) may have closed the field, and
    // the focus with it, before the key reached the window. The path was
    // fixed when the key was dispatched.
    const path = e.composedPath();
    const focus = path.includes(this.root) ? path[0] : document.activeElement;
    const inRoot = path.includes(this.root) || (focus && this.root.contains(focus));
    const editing = inRoot && (!!focus.isContentEditable || !!focus.closest(".nsh-field, [contenteditable], iframe"));
    const plain = !e.ctrlKey && !e.altKey && !e.metaKey;
    // The control the focus is on, which Return and Space press (a stop
    // that takes no presses, a `focusable` chart, hears them through the
    // shortcuts only); a system dialog over the page keeps its own keys.
    const control = inRoot && !editing && !!focus._pressable && !this.dialogs?.length;
    // The app's shortcuts first, where the focus is (`nsh/keymap`), then
    // reported. On a control, Return and Space fire only the focus' own.
    const found = this.shortcut(e, editing, control);
    if (found <= -3) {
      const id = -3 - found;
      this.call((w) => w.nsh_key_command(id));
    } else if (found !== -1) {
      e.preventDefault();
      e.stopPropagation();
      if (found >= 0) this.call((w) => w.nsh_key_command(found));
      return;
    }
    if (e.defaultPrevented || e.isComposing) return;
    // A key the focus hears as a raw transition goes to the core with the
    // browser's own logical key and DOM code, and its canonical
    // shortcut stroke for `captureKeys`; a mounted capture rule takes it
    // before the browser's defaults, as the native backends do. The core
    // answers from its own logical tree (an overlay's ancestors included).
    // Native fields, pages and videos keep their own keys.
    const keyView = this.keyFocusView();
    if (keyView && this.keyInterest(keyView) && this.rawKey(keyView, true, e, keyCode(e))) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    // Then they press the control (`nsh_core::input::presses_focused_control`):
    // a binding of Return elsewhere does not act instead of the control the
    // focus was moved to.
    if (control && plain && (e.key === "Enter" || e.key === " ")) {
      e.preventDefault();
      e.stopPropagation();
      if (e.repeat) return;
      // Return presses at once, Space when it is released, as buttons do.
      this.keyPress = { press: focus, states: this.ancestors(focus).filter((v) => v._tracked & PRESSED) };
      this.pressIn(this.keyPress);
      for (const v of this.keyPress.states) this.setState(v, PRESSED, true);
      if (e.key === "Enter") this.keyPressEnd(true);
      return;
    }
    const dialog = this.dialogs?.[this.dialogs.length - 1];
    if (dialog) {
      if (e.key === "Escape") {
        e.preventDefault();
        dialog._cancel();
      }
      return;
    }
    if (editing) {
      // Escape leaves the field.
      if (e.key === "Escape" && plain && focus.classList.contains("nsh-field")) {
        e.preventDefault();
        focus.blur();
      }
      return;
    }
    if (inRoot && plain && ((e.key === "F10" && e.shiftKey) || (e.key === "ContextMenu" && !e.shiftKey))) {
      // Prevent the native default when handled, so browsers that also
      // generate contextmenu do not open the same menu twice.
      if (this.contextMenu(e, true)) return;
    }
    if (this.selectionKey(e)) return;
    const backKey = e.key === "BrowserBack" || (e.altKey && !APPLE && e.key === "ArrowLeft") || (e.metaKey && APPLE && e.key === "[");
    if ((e.key === "Escape" && plain) || backKey) {
      // With history the browser goes back itself on its keys (`popState`).
      if (backKey && this.history) return;
      if (this.back()) e.preventDefault();
      return;
    }
    if (plain && this.scrollKey(e, inRoot ? focus : null)) e.preventDefault();
  }

  keyUp(e) {
    if (this.wasm) this.modifiersChanged(e);
    // The release of a key the core reports on the focused view: it decides
    // anew whether the mounted capture policy matches this transition
    // (`nsh_key_event`), as a browser delivers the release to whatever has
    // the focus now.
    let captured = false;
    if (this.wasm && !e.isComposing && e.keyCode !== 229 && this.takesKeys()) {
      const keyView = this.keyFocusView();
      if (keyView && this.keyInterest(keyView)) captured = this.rawKey(keyView, false, e, keyCode(e));
    }
    if (captured) {
      e.preventDefault();
      e.stopPropagation();
      // A release the policy took cancels what an uncaptured press armed
      // (Space down, Shift pressed, Space released): no onPress, and the
      // pressed states clear. Another key's captured release leaves it.
      if (e.key === " " && this.keyPress) this.keyPressEnd(false);
      return;
    }
    if (e.key === " " && this.keyPress) this.keyPressEnd(true);
  }

  keyPressEnd(inside) {
    const p = this.keyPress;
    this.keyPress = null;
    this.pressOut(p, inside);
    for (const v of p.states) this.setState(v, PRESSED, false);
  }

  /** The selectable text `el` is in. */
  selectableText(el) {
    return el?.closest(".nsh-selectable") ?? this.textAt(el);
  }

  /** What copying the selection in text gives: its runs in order, each
   * line's break after its last run (`_after`) and a newline between
   * texts; absolutely placed runs would each be a line of their own. In a
   * selectable view, texts on one row (their boxes overlap vertically: a
   * table's cells) are joined by a tab instead, a text that continues the
   * one before it (`continuesText`: a wrapped line's later part) by
   * nothing, attachments (which the runs do not hold) give their copy texts
   * (`copyText`) where the layout put them among the runs, and hidden runs
   * are left out, as the native platforms copy. */
  copyText(e) {
    if (e.target.closest?.(".nsh-field")) return;
    const out = this.selectedText();
    // Nothing selectable selected, or hidden characters only: the
    // clipboard keeps what it has.
    if (!out) return;
    e.preventDefault();
    e.clipboardData.setData("text/plain", out);
  }

  /** The selected text as {@link copyText} copies it, or null when nothing
   * selectable in this player is selected; within `only` (an element)
   * when given, of `given` (a range) instead of the selection when given. */
  selectedText(only = null, given = null) {
    let range = given;
    if (!range) {
      const sel = getSelection();
      if (!sel?.rangeCount || sel.isCollapsed || !this.root.contains(sel.anchorNode)) return null;
      range = sel.getRangeAt(0);
    }
    let out = "";
    let last = null;
    let lastArea = null;
    let lastBox = null;
    let found = false;
    // The runs the selection reaches, and the UTF-16 range it covers in
    // each text: the attachments in it are copied (as their `copyText`).
    // A run that starts with a truncated line's `…` has no offset and
    // leaves the range as it is: an attachment between it and the next
    // run of its line is copied only when the selection goes on past it.
    const reached = [];
    const covered = new Map();
    for (const run of (only ?? this.root).querySelectorAll(".nsh-run")) {
      // Text that cannot be selected is not copied, as by the browser.
      if (!range.intersectsNode(run) || !this.selectableText(run)) continue;
      // A link's characters are in a span inside the run.
      const text = run.textContent;
      if (!text) continue;
      const from = run.contains(range.startContainer) ? runOffset(run, range.startContainer, range.startOffset) : 0;
      const to = run.contains(range.endContainer) ? runOffset(run, range.endContainer, range.endOffset) : text.length;
      reached.push([run, text, from, to]);
      if (run._start == null || !run.parentNode._copyTexts) continue;
      const span = covered.get(run.parentNode);
      const start = run._start + from, end = run._start + Math.max(from, to);
      covered.set(run.parentNode, span ? [Math.min(span[0], start), Math.max(span[1], end)] : [start, end]);
    }
    const write = (run, s) => {
      if (!s) return;
      found = true;
      const area = this.areaOf(run.parentNode);
      if (last !== run.parentNode) {
        const box = area ? run.parentNode.getBoundingClientRect() : null;
        if (last && area && area === lastArea && run.parentNode._props?.continuesText) {
          out = out.replace(/\n$/, "");
        } else if (last && area && area === lastArea && box.top < lastBox.bottom && lastBox.top < box.bottom) {
          out = out.replace(/\n$/, "") + "\t";
        } else if (last && !out.endsWith("\n")) out += "\n";
        last = run.parentNode;
        lastArea = area;
        lastBox = box;
      }
      out += s;
    };
    for (const [run, text, from, to] of reached) {
      const span = covered.get(run.parentNode);
      const copies = (before) => span ? copiesAround(run.parentNode._copyTexts, run._run, before, span[0], span[1]) : "";
      write(run, copies(true));
      if (from < to) {
        found = true;
        // A hidden run (`visibility: hidden` on a span) keeps its place
        // but is not copied; the line's break after it still is.
        if (getComputedStyle(run).visibility !== "hidden") {
          const part = text.slice(from, to);
          write(run, this.areaOf(run.parentNode) ? part.replaceAll(ATTACHMENT, "") : part);
        }
      }
      write(run, copies(false));
      if (from < to && to === text.length && run._after) write(run, run._after);
    }
    if (!found) return null;
    return given ? out : out.replace(/\s+$/, "");
  }

  /** Where the selection starts in the copy of all of `area` (UTF-16
   * units): what maps it back to the document the area shows. */
  selectionStart(area) {
    const sel = getSelection();
    if (!sel?.rangeCount) return 0;
    const range = sel.getRangeAt(0);
    if (!area.contains(range.startContainer)) return 0;
    const before = document.createRange();
    before.setStart(area, 0);
    before.setEnd(range.startContainer, range.startOffset);
    if (before.collapsed) return 0;
    return (this.selectedText(area, before) ?? "").length;
  }

  /** The document's selection changed: the selectable view it is in (the
   * outermost) hears its text (`onSelectionChange`), and one it left hears
   * "" (nothing selected), each only when its text changed. */
  areaSelectionChanged() {
    const sel = getSelection();
    const anchor = sel?.rangeCount ? sel.anchorNode : null;
    const inRoot = anchor && this.root.contains(anchor);
    const area = inRoot ? this.areaOf(anchor.nodeType === 1 ? anchor : anchor.parentElement) : null;
    const last = this._selectedArea;
    if (last && last !== area) {
      this._selectedArea = null;
      if (last._selectedText && last._events?.has("onSelectionChange") && last.isConnected) {
        this.event(last._id, "onSelectionChange", { text: "", start: 0 });
      }
      last._selectedText = "";
    }
    if (!area) return;
    this._selectedArea = area;
    if (!area._events?.has("onSelectionChange")) return;
    const text = this.selectedText(area) ?? "";
    if (text === (area._selectedText ?? "")) return;
    area._selectedText = text;
    this.event(area._id, "onSelectionChange", { text, start: text ? this.selectionStart(area) : 0 });
  }

  /** Select all and Escape in selectable text with a selection: within it. */
  selectionKey(e) {
    const sel = getSelection();
    const anchor = sel?.anchorNode;
    const el = anchor?.nodeType === 1 ? anchor : anchor?.parentElement;
    // After select all in a selectable view the selection starts at the
    // view itself, outside its texts.
    const text = sel?.rangeCount && !sel.isCollapsed && anchor && this.root.contains(anchor)
      ? this.selectableText(el) ?? this.areaOf(el)
      : null;
    if (!text) return false;
    if (e.key === "a" && (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey) {
      e.preventDefault();
      // In a selectable view: all of its texts.
      sel.selectAllChildren(this.areaOf(text) ?? text);
      return true;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      sel.removeAllRanges();
      return true;
    }
    return false;
  }

  /** Arrows (40 points), Page Up / Down and Space / Shift+Space (a page),
   * Home / End scroll the scroll view around the focus, else the one under
   * the pointer. */
  scrollKey(e, focus) {
    const k = e.key;
    const horizontal = k === "ArrowLeft" || k === "ArrowRight";
    if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "PageUp", "PageDown", " ", "Home", "End"].includes(k)) return false;
    if (e.shiftKey && k !== " ") return false;
    let start = focus && focus !== this.root ? focus : null;
    if (!start && this.hover) start = document.elementFromPoint(this.hover[0], this.hover[1]);
    const chain = this.scrollChain(start);
    const el = chain.find((v) => !!v._horizontal === horizontal) ?? (horizontal ? null : chain[0]);
    if (!el) return false;
    const h = !!el._horizontal;
    const pos = h ? el.scrollLeft : el.scrollTop;
    const max = h ? el.scrollWidth - el.clientWidth : el.scrollHeight - el.clientHeight;
    const page = (h ? el.clientWidth : el.clientHeight) * 0.875;
    // The key's move, as `nsh_key_scroll` takes it: by points (0), by
    // pages (1), to the start (2), to the end (3).
    const [kind, amount] = { ArrowUp: [0, -40], ArrowLeft: [0, -40], ArrowDown: [0, 40], ArrowRight: [0, 40],
      PageUp: [1, -1], PageDown: [1, 1], " ": [1, e.shiftKey ? -1 : 1], Home: [2, 0], End: [3, 0] }[k];
    const d = [amount, amount * page, -pos, max - pos][kind];
    if (el._snapPoints) this.snapStep(el, Math.sign(d));
    else this.scrollSmoothly(el, h ? d : 0, h ? 0 : d, true);
    // A list follows its real end from here on (rows never rendered are
    // only estimated), and the other keys leave it.
    this.call((w) => w.nsh_key_scroll(el._id, kind, amount));
    return true;
  }

  // Wheels and touchpads

  /** The scroll views around `target` that scroll, innermost first. */
  scrollChain(target) {
    const view = target ? this.viewOf(target) : null;
    return view ? this.ancestors(view).filter((v) => v._kind === "scroll" && v._behavior?.enabled !== false) : [];
  }

  /**
   * A wheel or touchpad scroll goes to the innermost scroll view along its
   * axis that can move that way (a vertical wheel scrolls a horizontal view
   * when no vertical one can), and stays on it until the scroll ends
   * (events 200 ms apart). Where the browser would scroll the same view, it
   * does (`wheelNatively`): its notches glide as every page's. Otherwise
   * notches glide here; Ctrl + wheel (a touchpad's pinch) pinches the view
   * under the pointer and never zooms the page.
   */
  wheel(e) {
    // A view listening to `onWheel` nearer than the scroll views under the
    // pointer takes the wheel: nothing scrolls, zooms or pinches.
    if (this.wheelEvent(e)) {
      e.preventDefault();
      return;
    }
    if (e.ctrlKey) {
      e.preventDefault();
      // Over a zoomable scroll view it zooms that, else it pinches.
      if (!this.wheelZoom(e)) this.wheelPinch(e);
      return;
    }
    const unit = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? this.size[1] : 1;
    let dx = e.deltaX * unit;
    let dy = e.deltaY * unit;
    if (e.shiftKey && !dx) [dx, dy] = [dy, 0];
    const now = performance.now();
    let lock = this.wheelLock;
    if (!lock || now - lock.t > 200 || !lock.el.isConnected) {
      const chain = this.scrollChain(e.target);
      const horizontal = Math.abs(dx) > Math.abs(dy);
      const can = (v, d) => {
        const h = !!v._horizontal;
        const pos = h ? v.scrollLeft : v.scrollTop;
        const max = h ? v.scrollWidth - v.clientWidth : v.scrollHeight - v.clientHeight;
        return d < 0 ? pos > 0.5 : d > 0 && pos < max - 0.5;
      };
      const el = chain.find((v) => !!v._horizontal === horizontal && can(v, horizontal ? dx : dy))
        ?? (horizontal ? null : chain.find((v) => v._horizontal && can(v, dy)));
      // The browser scrolls it itself, with its own smooth wheel and the
      // touchpad's momentum, when it would pick the same view: the
      // innermost along the scroll's axis (`overscroll-behavior: contain`
      // keeps the scroll on it at its edge, as `wheelLock` does), not
      // snapping (one snap point per scroll) and without a content layer
      // (zoom, pull to refresh), whose offsets are nsh's.
      const native = !!el && !el._snapPoints && !el._layer
        && el === chain.find((v) => !!v._horizontal === horizontal);
      // Nothing to scroll: the page around may, unless a dialog or an
      // alert covers it.
      this.wheelLock = lock = el ? { el, total: 0, snapped: false, native } : null;
      if (!lock) {
        if (this.viewportDialogs && e.target.closest?.(".nsh-viewport")) e.preventDefault();
        return;
      }
    }
    lock.t = now;
    if (lock.native) {
      this.wheelNatively(lock.el);
      return;
    }
    e.preventDefault();
    const el = lock.el;
    const d = el._horizontal ? dx || dy : dy;
    if (el._snapPoints) {
      // One snap point per scroll.
      lock.total += d;
      if (!lock.snapped && Math.abs(lock.total) >= 20) {
        lock.snapped = true;
        this.snapStep(el, Math.sign(lock.total));
      }
      return;
    }
    // Wheel notches glide; touchpads move with the fingers.
    // Pixel-mode input may already contain touchpad inertia, including large
    // deltas. Its magnitude cannot distinguish a notch from a finger.
    const smooth = e.deltaMode !== 0;
    this.scrollSmoothly(el, el._horizontal ? d : 0, el._horizontal ? 0 : d, smooth);
  }

  /**
   * A wheel the browser scrolls `el` with (`wheel`): Chrome and Safari
   * send a mouse's notches in pixels, as a touchpad's deltas, so nsh could
   * not tell them apart and moved each notch at once, where every page
   * glides. The offsets reach the core as any scroll's do (`scrolled`).
   * A glide of the keys' stops where it is, without an end: the wheel's
   * scroll goes on from there. The end is the browser's `scrollend` once
   * no event came for 200 ms (`scrollEnded`: one scroll, as nsh's own
   * wheels end once), or 200 ms after the last scroll event where it sends
   * none (`waitCommandEnd`, which `scrolled` keeps waiting while it moves).
   */
  wheelNatively(el) {
    el._wheelAt = performance.now();
    const a = el._glide;
    if (a) {
      cancelAnimationFrame(a.frame);
      clearTimeout(a.timer);
      clearTimeout(a.watch);
      el._glide = null;
      this.drive(el, -1);
    }
    this.waitCommandEnd(el);
  }

  /**
   * `onWheel` of the nearest view around `e`'s target that listens; true
   * when it takes the wheel: no scroll view is nearer, nor is it one
   * (`input::wheel_listener`). One scroll stays where it went
   * (`input::WheelLatch`): a view that took it keeps it while it keeps
   * coming (events 200 ms apart, whichever way it turns, as `wheelLock`
   * keeps a scroll view's), and a scroll going on in a scroll view
   * (`wheelLock`) is only observed. Deltas are lines for
   * `DOM_DELTA_LINE`, points otherwise (a page is the viewport's height).
   */
  wheelEvent(e) {
    if (!this.wheelTracked?.size) return false;
    const now = performance.now();
    const held = this.wheelTaker;
    let el = null;
    let takes = false;
    if (held && now - held.t < 200
      && held.el.isConnected && held.el._events?.has("onWheel")) {
      el = held.el;
      takes = true;
    } else {
      [el, takes] = this.wheelListenerOf(e.target) ?? [null, false];
      if (takes && !e.ctrlKey) takes = this.wheelAlong(el, e);
      const lock = this.wheelLock;
      if (takes && lock && now - lock.t <= 200 && lock.el.isConnected) takes = false;
    }
    this.wheelTaker = takes ? { el, t: now } : null;
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const [pageX, pageY] = this.point(e);
    const page = e.deltaMode === 2 ? this.size[1] : 1;
    this.event(el._id, "onWheel", {
      position: { x: e.clientX - r.left, y: e.clientY - r.top },
      pagePosition: { x: pageX, y: pageY },
      delta: { x: e.deltaX * page, y: e.deltaY * page },
      deltaMode: e.deltaMode === 1 ? "lines" : "points",
      modifiers: { control: e.ctrlKey, alt: e.altKey, shift: e.shiftKey, platform: e.metaKey },
    });
    return takes;
  }

  /** Whether listener `el` takes wheel `e` along its axis
   * (`input::wheel_along`): a `panActivation` naming one axis takes only
   * wheels along it (Ctrl + wheel is checked by the caller); the others
   * reach the scroll views around it. */
  wheelAlong(el, e) {
    const a = el._props?.panActivation;
    if (!a) return true;
    const [ax, ay, fx, fy] = a;
    const way = this.panWay(a);
    const x = way ? way === "left" || way === "right" : ax != null || fy != null;
    const y = way ? !x : ay != null || fx != null;
    if (x === y) return true;
    let [dx, dy] = [e.deltaX, e.deltaY];
    if (e.shiftKey && !dx) [dx, dy] = [dy, 0];
    return (Math.abs(dx) > Math.abs(dy)) === x;
  }

  /** The nearest view around `target` listening to `onWheel`, and whether
   * it takes the wheel (`input::wheel_listener`): no scroll view is nearer,
   * nor is it one. */
  wheelListenerOf(target) {
    const view = this.viewOf(target);
    if (!view) return null;
    let scrollSeen = false;
    for (const el of this.ancestors(view)) {
      const scrolls = el._kind === "scroll";
      if (el._events?.has("onWheel")) return [el, !scrollSeen && !scrolls];
      scrollSeen ||= scrolls;
    }
    return null;
  }

  /** Moves `el` by (`dx`, `dy`), gliding there when `smooth`; once it
   * settles (no more input for 200 ms), `onScrollEnd`. */
  scrollSmoothly(el, dx, dy, smooth) {
    let a = el._glide;
    if (!a) {
      a = el._glide = { x: el.scrollLeft, y: el.scrollTop, frame: 0, timer: 0, last: 0 };
      this.drive(el, 1);
    }
    // Direct input takes over where the glide is displayed, not where it
    // was going. Keep fractional direct deltas between browser roundings.
    if (!smooth && a.frame) {
      [a.x, a.y] = a.at ?? [el.scrollLeft, el.scrollTop];
    }
    a.x = Math.min(Math.max(a.x + dx, 0), el.scrollWidth - el.clientWidth);
    a.y = Math.min(Math.max(a.y + dy, 0), el.scrollHeight - el.clientHeight);
    const settle = () => {
      if (a.frame || a.timer) return;
      el._glide = null;
      this.drive(el, -1);
      this.ownEnd(el);
    };
    if (!smooth) {
      cancelAnimationFrame(a.frame);
      a.frame = 0;
      el.scrollLeft = a.x;
      el.scrollTop = a.y;
    } else if (!a.frame) {
      a.last = performance.now();
      // Where the glide is: browsers round the offsets they are given.
      a.at = [el.scrollLeft, el.scrollTop];
      const step = (now) => {
        const k = 1 - Math.pow(0.75, (now - a.last) / 16.7);
        a.last = now;
        const x = a.at[0] + (a.x - a.at[0]) * k;
        const y = a.at[1] + (a.y - a.at[1]) * k;
        const done = Math.abs(a.x - x) < 0.5 && Math.abs(a.y - y) < 0.5;
        a.at = done ? [a.x, a.y] : [x, y];
        el.scrollLeft = a.at[0];
        el.scrollTop = a.at[1];
        a.frame = done ? 0 : requestAnimationFrame(step);
        if (done) settle();
      };
      a.frame = requestAnimationFrame(step);
    }
    // Its frames stopped (a hidden tab): it is where it was going, and
    // ends there.
    const watch = () => {
      if (!a.frame || el._glide !== a) return;
      if (performance.now() - a.last < 200) {
        a.watch = setTimeout(watch, 200);
        return;
      }
      cancelAnimationFrame(a.frame);
      a.frame = 0;
      a.at = [a.x, a.y];
      el.scrollLeft = a.x;
      el.scrollTop = a.y;
      settle();
    };
    clearTimeout(a.timer);
    a.timer = setTimeout(() => {
      a.timer = 0;
      clearTimeout(a.watch);
      if (a.frame) watch();
      else settle();
    }, 200);
  }

  /** Stops `el`'s glide where it is for a scroll command of the core's to
   * (`x`, `y`), as the native backends interrupt theirs: left running, its
   * next frame would put the offset back. The browser's `scrollend` after
   * the command's scroll ends the scroll it stopped; a command that leaves
   * the view where it is moves nothing, and no `scrollend` follows, so its
   * `onScrollEnd` is sent here. */
  stopGlide(el, x, y) {
    if (!this.cancelGlide(el)) return;
    if (this.scrolledTo(el, x, y)) {
      this.ownEnd(el);
    } else {
      // A fractional destination may round back to the current offset,
      // in which case the browser sends no scrollend. Moving commands
      // keep this fallback waiting through their scroll events.
      this.waitCommandEnd(el);
    }
  }

  /** Stops `el`'s glide where it is, for something that takes it over;
   * whether there was one. */
  cancelGlide(el) {
    const a = el._glide;
    if (!a) return false;
    cancelAnimationFrame(a.frame);
    clearTimeout(a.timer);
    clearTimeout(a.watch);
    el._glide = null;
    this.drive(el, -1);
    return true;
  }

  /** `ScrollTo` and `ScrollToEnd` of the core: puts `el` at (`x`, `y`),
   * animating it over `SCROLL_MS` when `animated`. */
  scrollCommand(el, x, y, animated) {
    el._applied++;
    if (!animated) {
      this.endScrollAnimation(el, false);
      this.stopGlide(el, x, y);
      el.scrollTo({ left: x, top: y, behavior: "instant" });
      return;
    }
    // The animation below ends the scroll it takes over, so the glide
    // only stops.
    this.cancelGlide(el);
    this.animateScroll(el, x, y);
  }

  /** Moves `el` to (`x`, `y`) over `SCROLL_MS`, eased out cubically, as
   * the core animates a scroll of its own on the other platforms. A
   * command that retargets one in flight carries on from where it is, as
   * the core's `animate_to` does. */
  animateScroll(el, x, y) {
    let a = el._smooth;
    if (!a) {
      a = el._smooth = { fromX: 0, fromY: 0, x: 0, y: 0, start: 0, frame: 0, step: null, watch: 0 };
      a.step = (now) => this.stepScroll(el, a, now);
      this.drive(el, 1);
    }
    a.fromX = el.scrollLeft;
    a.fromY = el.scrollTop;
    a.x = x;
    a.y = y;
    a.start = performance.now();
    // Its frames stopped (a hidden tab): it is where it was going, and
    // ends there, as a glide's do (`scrollSmoothly`). One timer an
    // animation, not one a frame.
    clearTimeout(a.watch);
    a.watch = setTimeout(() => {
      el.scrollLeft = a.x;
      el.scrollTop = a.y;
      this.endScrollAnimation(el, true);
    }, SCROLL_MS + 200);
    if (!a.frame) a.frame = requestAnimationFrame(a.step);
  }

  /** One frame of `el`'s scroll animation (`animateScroll`). */
  stepScroll(el, a, now) {
    const t = Math.min((now - a.start) / SCROLL_MS, 1);
    const k = 1 - (1 - t) ** 3;
    el.scrollLeft = a.fromX + (a.x - a.fromX) * k;
    el.scrollTop = a.fromY + (a.y - a.fromY) * k;
    if (t < 1) {
      a.frame = requestAnimationFrame(a.step);
      return;
    }
    a.frame = 0;
    this.endScrollAnimation(el, true);
  }

  /** `el`'s scroll animation is over: `reached` when it ran to its target,
   * which ends the scroll, rather than being taken over by input or a
   * command that does not animate. */
  endScrollAnimation(el, reached) {
    const a = el._smooth;
    if (!a) return;
    cancelAnimationFrame(a.frame);
    clearTimeout(a.watch);
    el._smooth = null;
    this.drive(el, -1);
    if (reached) this.ownEnd(el);
  }

  /** Whether `el` is where a scroll to (`x`, `y`) leaves it: browsers
   * clamp the offsets of scrolls. A fractional destination they round
   * away from lands elsewhere, and ends on the fallback below. */
  scrolledTo(el, x, y) {
    const at = (to, pos, max) => Math.min(Math.max(to, 0), max) === pos;
    return at(x, el.scrollLeft, el.scrollWidth - el.clientWidth) && at(y, el.scrollTop, el.scrollHeight - el.clientHeight);
  }

  /** Ends a command rounded to the current offset when no browser event
   * follows; scroll events keep a moving command's fallback waiting. */
  waitCommandEnd(el) {
    clearTimeout(el._commandEnd);
    el._commandEnd = setTimeout(() => {
      this.scrollEnded(el);
      el._ownEnd = [el.scrollLeft, el.scrollTop];
    }, 200);
  }

  /** The snap point of a snapping view next to where it is towards `dir`
   * (0: the nearest). */
  snapPoint(el, dir) {
    const pos = el._horizontal ? el.scrollLeft : el.scrollTop;
    const points = el._snapPoints;
    if (dir > 0) return points.find((p) => p > pos + 1);
    if (dir < 0) return [...points].reverse().find((p) => p < pos - 1);
    return points.reduce((a, b) => (Math.abs(b - pos) < Math.abs(a - pos) ? b : a));
  }

  /** Scrolls a snapping view to its next snap point towards `dir`. */
  snapStep(el, dir) {
    if (dir) this.snapTo(el, this.snapPoint(el, dir));
  }

  /** Glides to snap point `target` as the momentum of a scroll (the
   * browser's `scrollend` ends it); false when it is there. */
  snapTo(el, target) {
    const h = !!el._horizontal;
    if (target == null || Math.abs(target - (h ? el.scrollLeft : el.scrollTop)) < 1) return false;
    el._momentum = true;
    this.scrollEvent(el, "onMomentumStart");
    el.scrollTo({ [h ? "left" : "top"]: target, behavior: "smooth" });
    return true;
  }

  /** Ctrl + wheel pinches the view under the pointer (animated values),
   * ending when the wheel stops for 150 ms. */
  wheelPinch(e) {
    let t = this.wheelPinchState;
    if (!t) {
      const view = this.viewOf(e.target);
      const el = view && this.ancestors(view).find((v) => v._gestures?.pinch);
      if (!el) return;
      t = this.wheelPinchState = { el, scale: 1, timer: 0 };
      this.call((w) => w.nsh_transform_gesture(el._id, 0, 0, 1));
    }
    t.scale *= Math.exp(-e.deltaY / 100);
    this.call((w) => w.nsh_transform_gesture(t.el._id, 0, 1, t.scale));
    clearTimeout(t.timer);
    t.timer = setTimeout(() => {
      this.wheelPinchState = null;
      this.call((w) => w.nsh_transform_gesture(t.el._id, 0, 2, t.scale));
    }, 150);
  }

  /** Counts what drives `el`'s scrolling here (zoomable views' pans,
   * glides, wheels, keys): meanwhile the browser's `scrollend` is not the
   * end. */
  drive(el, n) {
    el._driven = Math.max(0, (el._driven ?? 0) + n);
  }

  /** `onScrollEnd` of a scroll driven here; the browser's `scrollend`
   * that may follow at the same offset is not another. */
  ownEnd(el) {
    el._ownEnd = [el.scrollLeft, el.scrollTop];
    this.scrollEvent(el, "onScrollEnd");
  }

  scrollEvent(el, name) {
    // Snapping animated values that follow it settle, listened to or not.
    if (name === "onScrollEnd") this.call((w) => w.nsh_scroll_ended(el._id));
    if (el._events.has(name)) this.event(el._id, name, { x: el.scrollLeft, y: el.scrollTop });
  }

  /** Where `e` is in the coordinates of the root view it is on: the root,
   * or `layer`, a dialog over the window. */
  point(e, layer = this.windowLayer(e.target)) {
    const [left, top] = this.origin(layer);
    const [sx, sy] = this.layerScale(layer);
    return [e.clientX / sx - left, e.clientY / sy - top];
  }

  /**
   * Files dragged in from the system (`onFileDragEnter`, `onFileDragLeave`,
   * `onFileDrop`): the nearest view up from the one under the pointer that
   * listens takes the drag. Only there is the browser's default (opening
   * the file) cancelled; elsewhere the page behaves as without NSH. Only
   * file drags count: text and links dragged in are left alone. Moving
   * between a receiver's children enters and leaves nothing.
   */
  installFileDrop(root) {
    const hasFiles = (e) => [...(e.dataTransfer?.types ?? [])].includes("Files");
    const receiver = (target) => {
      for (let el = target; el && el !== root.parentNode; el = el.parentNode) {
        if (el._events && FILE_DROP_EVENTS.some((n) => el._events.has(n))) return el;
      }
      return null;
    };
    let current = null;
    let leaveTimer = 0;
    const leave = () => {
      clearTimeout(leaveTimer);
      leaveTimer = 0;
      const old = current;
      current = null;
      if (old?._events.has("onFileDragLeave")) this.event(old._id, "onFileDragLeave");
    };
    const track = (e) => {
      if (!hasFiles(e)) return;
      const el = receiver(e.target);
      clearTimeout(leaveTimer);
      leaveTimer = 0;
      if (el !== current) {
        leave();
        current = el;
        if (el?._events.has("onFileDragEnter")) {
          // Only the types: the browser keeps the files until the drop.
          const mimeTypes = [...e.dataTransfer.items].filter((i) => i.kind === "file").map((i) => i.type);
          this.fileDrop(el, 0, { mimeTypes, files: [] }, []);
        }
      }
      if (el?._events.has("onFileDrop")) {
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
      }
    };
    root.addEventListener("dragenter", track);
    root.addEventListener("dragover", track);
    // A leave toward a child is followed at once by its enter: leave only
    // when none comes.
    root.addEventListener("dragleave", (e) => {
      if (!hasFiles(e) || !current) return;
      clearTimeout(leaveTimer);
      leaveTimer = setTimeout(leave, 50);
    });
    root.addEventListener("drop", (e) => {
      if (!hasFiles(e)) return;
      const el = receiver(e.target);
      const target = current;
      clearTimeout(leaveTimer);
      leaveTimer = 0;
      current = null;
      if (target && target !== el && target._events.has("onFileDragLeave")) this.event(target._id, "onFileDragLeave");
      if (!el?._events.has("onFileDrop")) return;
      e.preventDefault();
      // The items are only readable in this handler: keep the `File`s now.
      // Directories are left out (their `File` has no bytes to read).
      const files = [];
      const mimeTypes = [];
      for (const item of e.dataTransfer.items) {
        if (item.kind !== "file") continue;
        mimeTypes.push(item.type);
        if (item.webkitGetAsEntry?.()?.isDirectory) continue;
        const file = item.getAsFile();
        if (file && files.length < FILE_DROP_LIMIT) files.push(file);
      }
      const [x, y] = this.point(e);
      const app = this.app;
      let budget = FILE_DROP_MAX_BYTES;
      Promise.all(files.map(async (f) => {
        if (f.size > budget) return null;
        budget -= f.size;
        try {
          return new Uint8Array(await f.arrayBuffer());
        } catch {
          return undefined;
        }
      })).then((buffers) => {
        if (app !== this.app) return;
        const parts = [];
        const meta = [];
        files.forEach((f, i) => {
          const b = buffers[i];
          if (b === undefined) return; // Unreadable: left out.
          if (b === null) console.warn(`nsh: the dropped ${f.name} is not read: past ${FILE_DROP_MAX_BYTES} bytes a drop`);
          meta.push({ name: f.name, type: f.type, size: b ? b.byteLength : f.size, read: !!b, lastModified: f.lastModified });
          if (b) parts.push(b);
        });
        this.fileDrop(el, 1, { mimeTypes, x, y, files: meta }, parts);
      });
    });
  }

  /** Sends a file drag (`kind` 0: enter, 1: drop) of `el` to the engine, with the read files' bytes. */
  fileDrop(el, kind, info, parts) {
    const size = parts.reduce((n, b) => n + b.byteLength, 0);
    const bytes = new Uint8Array(size);
    let at = 0;
    for (const b of parts) {
      bytes.set(b, at);
      at += b.byteLength;
    }
    const json = JSON.stringify(info);
    this.call(() => this.withStrings([json, bytes], (jp, jl, bp, bl) => this.wasm.nsh_file_drop(el._id, kind, jp, jl, bp, bl)));
  }

  /** The scale layer `layer` is drawn at (`scaleLayer`): its points are
   * the window's divided by it. */
  layerScale(layer) {
    return (layer && this.frameScale) || [1, 1];
  }

  /** The top left of `el` in the coordinates `point` gives for `layer`. */
  corner(el, layer) {
    const r = el.getBoundingClientRect();
    const [left, top] = this.origin(layer);
    const [sx, sy] = this.layerScale(layer);
    return [r.left / sx - left, r.top / sy - top];
  }

  /** The dialog over the window (`viewportDialogs`) that `node` is in, if
   * any: a root view of its own, laid out in the window's coordinates. */
  windowLayer(node) {
    return this.viewportDialogs ? node?.closest?.(".nsh-modal.nsh-viewport") ?? null : null;
  }

  /** The client position of the top left of the root, or of the window for
   * a dialog over it (`layer`), whose motion moves its views, not their
   * layout. */
  origin(layer) {
    if (layer) return [0, 0];
    const r = this.root.getBoundingClientRect();
    return [r.left, r.top];
  }

  touchEvent(phase, changedId, activated) {
    const points = [];
    for (const [id, p] of this.pointers) {
      if (!p.touchPath.length) continue;
      const target = p.touchPath[0];
      const view = this.view(target);
      const [left, top] = view ? this.corner(view, p.layer) : [0, 0];
      points.push({
        id, target, path: p.touchPath,
        pageX: p.x, pageY: p.y,
        x: p.x - left,
        y: p.y - top,
        changed: id === changedId,
        pointerType: p.pointerType,
        pressure: p.pressure, tiltX: p.tiltX, tiltY: p.tiltY,
      });
    }
    if (!points.length) return;
    // The keys held when the changed pointer went down, as its press's.
    const modifiers = this.pointers.get(changedId)?.modifiers;
    const json = JSON.stringify({ phase, time: performance.now(), points, activated, modifiers });
    this.call(() => this.withStrings([json], (p, l) => this.wasm.nsh_touch(p, l)));
  }

  /** A click leaves the keyboard focus where it is (in a field, too) and
   * selects nothing, as in native apps; fields, selectable text and hosted
   * pages and videos take it as usual. A touch moves the focus as the
   * browser does (a tap outside a field leaves it, and the keyboard
   * closes), unless its own press put the focus in a field (an editor's
   * text): the mouse events the browser makes of the touch would take the
   * focus to the pressable, and close the keyboard as it opens. */
  mouseDown(e) {
    if (this.editable(e.target)) return;
    if (this.lastPointer === "touch" && !(this.pressFocus && this.pressFocus === document.activeElement)) return;
    e.preventDefault();
    // Which would also keep the keys from an app in an iframe.
    if (!document.hasFocus()) window.focus();
  }

  pointerDown(e) {
    this.lastPointer = e.pointerType;
    // The field this press makes the app focus, if any (`mouseDown`).
    this.pressFocus = null;
    // A press without a move still holds a button: a modifier key then
    // fires no hover move (`modifiersChanged`).
    if (e.pointerType === "mouse") this.hoverButtons = e.buttons;
    Player.active = this;
    if (e.button > 0) return;
    // A click with a modifier key on a link is the browser's, as a middle
    // click is: it opens the link in a new tab or window (the click
    // listener of `installInput` leaves it to the browser), so the link
    // does not also take the press and open it here.
    if (heldModifier(e) && e.target?.closest?.(LINK_SELECTOR)) return;
    if (e.pointerType === "mouse" && this.desktopUI && this.grabBar(e)) return;
    // A drag selects in selectable text and fields instead of panning a
    // zoomable view.
    const selects = this.editable(e.target);
    // A press elsewhere clears a selection in text, as on a web page (the
    // browser does not, as presses here select nothing).
    const sel = getSelection();
    if (!selects && e.pointerType === "mouse" && sel?.rangeCount && !sel.isCollapsed && this.root.contains(sel.anchorNode)) {
      sel.removeAllRanges();
    }
    const target = this.viewOf(e.target);
    if (!target) return;
    const isField = e.target.classList?.contains("nsh-field");
    const chain = this.ancestors(target);
    // Its positions are in the coordinates of the root view it went down on.
    const layer = this.windowLayer(e.target);
    const [x, y] = this.point(e, layer);
    // Mouse drags never scroll (the wheel, the touchpad, the keyboard and
    // the scroll bar do: dragging the content is a touchscreen's way);
    // touches scroll natively, except in zoomable views, which pan and
    // pinch here.
    const scrollView = isField ? null : chain.find((v) => v._kind === "scroll") ?? null;
    const link = isField ? null : this.linkPress(e.target, target);
    // An edge pan starts only from its edge of the page (of the window for
    // a dialog over it): away from it, neither of its pans does.
    const [w, h] = layer ? [innerWidth, innerHeight] : [this.root.clientWidth, this.root.clientHeight];
    const admits = (v) => this.startsAt(v._props?.panActivation, x, y, w, h);
    const p = {
      x, y, layer, startX: x, startY: y, t: performance.now(), vx: 0, vy: 0,
      pointerType: e.pointerType,
      pressure: e.pressure, tiltX: e.tiltX || 0, tiltY: e.tiltY || 0,
      touchPath: chain.filter((v) => v._events.has("onTouch")).map((v) => v._id),
      ...(isField ? { press: null } : link ? { press: link } : this.pickPress(chain)),
      // What presses report: the modifier keys at the press and its clicks.
      modifiers: { control: e.ctrlKey, alt: e.altKey, shift: e.shiftKey, platform: e.metaKey },
      clicks: e.pointerType === "mouse" ? this.clickCount(x, y) : 1,
      pan: chain.find((v) => (v._gestures?.pan || v._events.has("onPanStart") || v._events.has("onPanEnd")) && admits(v)) ?? null,
      scroll: !selects && scrollView && e.pointerType !== "mouse" && this.zooms(scrollView) ? scrollView : null,
      // Touch scrolling is the browser's, reported from here (`touchScroll`).
      scrolls: e.pointerType === "touch" ? chain.filter((v) => v._kind === "scroll") : null,
      zoom: chain.find((v) => this.zooms(v) && v._behavior.pinch) ?? null,
      pinch: chain.find((v) => v._gestures?.pinch || v._gestures?.rotation) ?? null,
      // `panActivation`: decided here as the pointer moves (PanActivation::decide).
      gate: chain.find((v) => v._props?.panActivation && admits(v)) ?? null,
      gateState: 0,
      states: chain.filter((v) => v._tracked & PRESSED),
      mode: null,
    };
    this.pointers.set(e.pointerId, p);
    if (p.touchPath.length) this.touchEvent(0, e.pointerId);
    if (this.pointers.size === 2) this.startTwoFinger();
    if (p.press) this.pressIn(p);
    for (const v of p.states) this.setState(v, PRESSED, true);
    // A field in a draggable view still takes focus: preventing the default
    // keeps the browser from focusing it.
    if ((p.scroll || p.pan) && !isField) e.preventDefault();
  }

  /** The press of the views in `chain` (innermost first): `{ press,
   * longPress }`. The innermost enabled view with a press listener gets it;
   * one that listens only to `onLongPress` leaves the taps to the nearest
   * enabled view outwards that listens to them, as a long press recognizer
   * takes no taps from the views around it, and keeps the long press
   * (`input::pick_press`). */
  pickPress(chain) {
    const taps = (v) => TAP_EVENTS.some((n) => v._events.has(n));
    let long = null;
    for (const v of chain) {
      if (v._props?.disabled || !PRESS_EVENTS.some((n) => v._events.has(n))) continue;
      if (!long) {
        if (taps(v)) return { press: v, longPress: null };
        long = v;
      } else if (taps(v)) {
        return { press: v, longPress: long };
      }
    }
    return { press: long, longPress: null };
  }

  /** The press target of a press on a link's run in text view `view`: the
   * link's node, its events, placed as the text (as on the other
   * platforms, a link's press reports positions in its text). */
  linkPress(target, view) {
    const link = target?._link;
    if (!link || !PRESS_EVENTS.some((n) => link.events.has(n))) return null;
    return {
      _id: link.node,
      _events: link.events,
      _props: view._props,
      getBoundingClientRect: () => view.getBoundingClientRect(),
    };
  }

  pressIn(p) {
    const el = p.press;
    p.pressed = true;
    if (el._events.has("onPressIn")) this.event(el._id, "onPressIn", this.pressPayload(p));
    const long = p.longPress ?? el;
    if (long._events.has("onLongPress")) {
      p.longTimer = setTimeout(() => {
        p.long = true;
        this.event(long._id, "onLongPress", this.pressPayload(p));
      }, long._props?.longPressDelay ?? 500);
    }
  }

  pressOut(p, inside) {
    const el = p.press;
    if (!el || !p.pressed) return;
    p.pressed = false;
    clearTimeout(p.longTimer);
    if (el._events.has("onPressOut")) this.event(el._id, "onPressOut", this.pressPayload(p));
    if (inside && !p.long && el._events.has("onPress")) this.event(el._id, "onPress", this.pressPayload(p));
  }

  /** The payload of pointer `p`'s press events, `{ position, pagePosition,
   * modifiers, clicks }` as handlers get it; none for a press from the
   * keyboard (`keyPress`), which has no pointer. */
  pressPayload(p) {
    if (p.x === undefined) return null;
    const [left, top] = this.corner(p.press, p.layer);
    return {
      position: { x: p.x - left, y: p.y - top },
      pagePosition: { x: p.x, y: p.y },
      modifiers: p.modifiers,
      clicks: p.clicks,
    };
  }

  /** A mouse press's click count at `(x, y)` (root coordinates): 2 or 3
   * when it follows the last one quickly and close by. */
  clickCount(x, y) {
    const now = performance.now();
    const last = this.lastClick;
    const n = last && now - last.t <= 500 && Math.abs(x - last.x) <= 5 && Math.abs(y - last.y) <= 5 ? (last.n % 3) + 1 : 1;
    this.lastClick = { t: now, x, y, n };
    return n;
  }

  /** Remembers where pointer `p` is at `now` (ms), for its velocity. */
  track(p, now) {
    const samples = (p.samples ??= []);
    samples.push([now, p.x, p.y]);
    if (samples.length > 16) samples.shift();
  }

  /** Pointer `p`'s velocity in points per second over its last
   * VELOCITY_WINDOW ms (zero after a pause), as the Linux backend
   * measures it: events come at uneven intervals, a pair of them is noise. */
  velocity(p) {
    const samples = p.samples ?? [];
    const newest = samples[samples.length - 1];
    if (!newest) return [0, 0];
    let oldest = newest;
    for (let i = samples.length - 2; i >= 0 && newest[0] - samples[i][0] <= VELOCITY_WINDOW; i--) oldest = samples[i];
    const dt = newest[0] - oldest[0];
    if (dt < 1) return [0, 0];
    return [(newest[1] - oldest[1]) / dt * 1000, (newest[2] - oldest[2]) / dt * 1000];
  }

  pointerMove(e) {
    const p = this.pointers.get(e.pointerId);
    if (!p) return;
    if (p.mode === "bar") {
      e.preventDefault();
      this.dragBar(p, e);
      return;
    }
    const [x, y] = this.point(e, p.layer);
    const now = performance.now();
    const dt = Math.max(1, now - p.t);
    p.vx = ((x - p.x) / dt) * 1000;
    p.vy = ((y - p.y) / dt) * 1000;
    const dx = x - p.lastX0 || 0;
    p.lastX0 = x;
    p.x = x;
    p.y = y;
    p.t = now;
    p.pressure = e.pressure;
    p.tiltX = e.tiltX || 0;
    p.tiltY = e.tiltY || 0;
    this.track(p, now);
    const tx = x - p.startX;
    const ty = y - p.startY;
    const activated = this.decideGate(p, tx, ty);
    if (p.touchPath.length) this.touchEvent(1, e.pointerId, activated);
    if (this.twoFinger) {
      this.moveTwoFinger();
      return;
    }
    // A scroll view waits while the gate's pan may still activate, and
    // never gets an activated one.
    const gated = p.gate && p.gateState !== 2;
    if (gated && p.gateState === 1) e.preventDefault();
    if (!p.mode && Math.hypot(tx, ty) > 6) {
      // A pan with a `panActivation` starts when that activates; failed, the
      // drag is the views' around it.
      const activation = p.pan?._props?.panActivation;
      const decision = !p.pan || !activation ? !!p.pan : this.decideActivation(activation, tx, ty);
      if (decision === false) p.pan = null;
      if (decision) {
        p.mode = "pan";
        this.call((w) => w.nsh_pan(p.pan._id, 0, 0, 0, 0, 0, p.startX, p.startY));
      } else if (!p.pan && p.scroll && !gated) {
        p.mode = "scroll";
        p.at = [p.scroll.scrollLeft, p.scroll.scrollTop];
        p.dragged = [0, 0];
        p.handoff = [null, null];
        cancelAnimationFrame(p.scroll._zoomAnimation);
        this.drive(p.scroll, 1);
        this.scrollEvent(p.scroll, "onScrollDragStart");
      }
      if (p.mode || Math.hypot(tx, ty) > 10) {
        this.pressOut(p, false);
        for (const v of p.states) this.setState(v, PRESSED, false);
      }
    }
    if (p.mode === "pan") {
      e.preventDefault();
      const [vx, vy] = this.velocity(p);
      this.call((w) => w.nsh_pan(p.pan._id, 1, tx, ty, vx, vy, p.startX, p.startY));
    } else if (p.mode === "scroll") {
      e.preventDefault();
      const d = [p.dragged[0] - tx, p.dragged[1] - ty];
      p.dragged = [tx, ty];
      for (const axis of [0, 1]) this.chainDrag(p, axis, d[axis]);
    }
    void dx;
  }

  /**
   * Moves the zoomable view pointer `p` pans by `d` along `axis` (0: x),
   * and what it cannot take the nearest scroll view around it that can
   * move that way, as UIKit's nested scroll views do: a pager pages from
   * an image not zoomed in, or panned to its edge. Turning back, that view
   * goes back to where it was before the image pans again.
   */
  chainDrag(p, axis, d) {
    if (!d) return;
    const pos = (el) => (axis ? el.scrollTop : el.scrollLeft);
    const max = (el) => Math.max(0, axis ? el.scrollHeight - el.clientHeight : el.scrollWidth - el.clientWidth);
    const set = (el, v) => (axis ? (el.scrollTop = v) : (el.scrollLeft = v));
    let h = p.handoff[axis];
    if (h && (h.at - h.start) * d < 0) {
      const back = Math.abs(d) < Math.abs(h.at - h.start) ? d : h.start - h.at;
      h.at += back;
      set(h.el, h.at);
      d -= back;
    }
    const s = p.scroll;
    const at = Math.min(Math.max(p.at[axis] + d, 0), max(s));
    d -= at - p.at[axis];
    p.at[axis] = at;
    set(s, at);
    if (Math.abs(d) < 0.01) return;
    if (!h) {
      const el = this.ancestors(s).slice(1).find((v) => v._kind === "scroll" && v._behavior?.enabled !== false
        && (this.zooms(v) || !!v._horizontal === !axis) && (d < 0 ? pos(v) > 0.5 : pos(v) < max(v) - 0.5));
      if (!el) return;
      h = p.handoff[axis] = { el, start: pos(el), at: pos(el) };
      // It snaps once released (`releaseHandoff`), not under the finger.
      el.style.scrollSnapType = "none";
      if (el._momentum) {
        el._momentum = false;
        this.scrollEvent(el, "onMomentumEnd");
      }
      this.drive(el, 1);
      this.scrollEvent(el, "onScrollDragStart");
    }
    h.at = Math.min(Math.max(h.at + d, 0), max(h.el));
    set(h.el, h.at);
  }

  /** Ends the part of a drag scroll view `el` took along `axis`
   * (`chainDrag`), released at `v` points per second: a snapping view
   * settles on a snap point, another glides. */
  releaseHandoff(el, axis, v) {
    this.scrollEvent(el, "onScrollDragEnd");
    if (el._snapPoints) {
      this.drive(el, -1);
      el._restoreSnap = true;
      if (!this.snapTo(el, this.releaseSnap(el, v / 1000))) {
        el._restoreSnap = false;
        el.style.scrollSnapType = "";
        this.ownEnd(el);
      }
    } else {
      el.style.scrollSnapType = "";
      // Its end undoes `drive`.
      this.glide(el, axis ? 0 : v, axis ? v : 0);
    }
  }

  /** The snap point a snapping view released at `v` (points per ms)
   * settles on, as the core's `snap_target` picks it: faster than 0.3,
   * pages and snap intervals (one stop per scroll here) move one point,
   * other snap points round where the glide would go that way; slower,
   * the nearest. */
  releaseSnap(el, v) {
    const b = el._behavior;
    const dir = v > 0.3 ? 1 : v < -0.3 ? -1 : 0;
    if (!dir || b.paging || b.snapInterval > 0) return this.snapPoint(el, dir);
    // Snapping glides decelerate by 0.99 per ms (`scroll::rate`).
    const projected = (el._horizontal ? el.scrollLeft : el.scrollTop) - v / Math.log(0.99);
    const points = el._snapPoints;
    return (dir > 0 ? points.find((q) => q >= projected - 0.5) : [...points].reverse().find((q) => q <= projected + 0.5))
      ?? this.snapPoint(el, dir);
  }

  /** The gate's node id when its pan activates with this move (else undefined). */
  decideGate(p, dx, dy) {
    if (!p.gate || p.gateState !== 0) return undefined;
    const decision = this.decideActivation(p.gate._props.panActivation, dx, dy);
    if (decision === false) {
      p.gateState = 2;
      return undefined;
    }
    if (!decision) return undefined;
    p.gateState = 1;
    this.pressOut(p, false);
    return p.gate._id;
  }

  /** The way `panActivation` `a` (`[activeX, activeY, failX, failY,
   * direction, edge]`) activates in, if any: away from its edge, else its
   * direction (`PanActivation::way`). */
  panWay(a) {
    const away = { left: "right", right: "left", top: "down", bottom: "up" };
    return a[5] != null ? away[a[5]] : a[4] ?? undefined;
  }

  /** `PanActivation::decide` on a drag by (dx, dy): true activates, false
   * fails, undefined waits. */
  decideActivation(a, dx, dy) {
    const [ax, ay, fx, fy] = a;
    const past = (limit, d) => limit != null && Math.abs(d) > limit;
    if (past(fx, dx) || past(fy, dy)) return false;
    const way = this.panWay(a);
    if (way) {
      const horizontal = way === "left" || way === "right";
      const along = (way === "right" || way === "down" ? 1 : -1) * (horizontal ? dx : dy);
      const across = Math.abs(horizontal ? dy : dx);
      const limit = (horizontal ? ax : ay) ?? 10;
      if (along > limit && along >= across) return true;
      const acrossFails = (horizontal ? fy : fx) == null && across > limit && across > along;
      return -along > limit || acrossFails ? false : undefined;
    }
    const active = ax == null && ay == null ? Math.hypot(dx, dy) > 10 : past(ax, dx) || past(ay, dy);
    return active ? true : undefined;
  }

  /** `PanActivation::starts_at`: whether a pointer going down at (x, y) in
   * an area of `w` × `h` may start the pans of a view with `panActivation`
   * `a`: anywhere without an edge, else within 20 points of it. */
  startsAt(a, x, y, w, h) {
    switch (a?.[5]) {
      case "left": return x <= 20;
      case "right": return x >= w - 20;
      case "top": return y <= 20;
      case "bottom": return y >= h - 20;
      default: return true;
    }
  }

  pointerUp(e, cancelled) {
    if (e.pointerType === "mouse") {
      this.hoverButtons = e.buttons;
      // Before the press's end, as the desktops report it, and for every
      // button: a secondary click tracks no pointer down (`pointerDown`).
      if (!cancelled) this.mouseUp(e);
    }
    const p = this.pointers.get(e.pointerId);
    if (!p) return;
    if (p.mode === "bar") {
      this.pointers.delete(e.pointerId);
      this.releaseBar(p.scroll);
      return;
    }
    if (cancelled && p.scrolls?.length) this.touchScroll(p, this.point(e, p.layer));
    p.pressure = 0;
    if (p.touchPath.length) this.touchEvent(cancelled ? 3 : 2, e.pointerId);
    this.pointers.delete(e.pointerId);
    if (this.twoFinger) {
      this.endTwoFinger();
      return;
    }
    for (const v of p.states) this.setState(v, PRESSED, false);
    if (p.mode === "pan") {
      // Released after a pause: no speed left.
      this.track(p, performance.now());
      const [vx, vy] = this.velocity(p);
      this.call((w) => w.nsh_pan(p.pan._id, cancelled ? 3 : 2, p.x - p.startX, p.y - p.startY, vx, vy, p.startX, p.startY));
    } else if (p.mode === "scroll") {
      this.scrollEvent(p.scroll, "onScrollDragEnd");
      this.track(p, performance.now());
      const [vx, vy] = cancelled ? [0, 0] : this.velocity(p);
      const glide = [-p.vx, -p.vy];
      for (const axis of [0, 1]) {
        if (!p.handoff[axis]) continue;
        // The image stays at its edge; the view around goes on.
        glide[axis] = 0;
        this.releaseHandoff(p.handoff[axis].el, axis, axis ? -vy : -vx);
      }
      this.glide(p.scroll, glide[0], glide[1]);
    } else if (p.press) {
      if (!cancelled) [p.x, p.y] = this.point(e, p.layer);
      const rect = p.press.getBoundingClientRect();
      const inside = e.clientX >= rect.left - 8 && e.clientX <= rect.right + 8 && e.clientY >= rect.top - 8 && e.clientY <= rect.bottom + 8;
      this.pressOut(p, inside && !cancelled);
    }
  }

  /** The browser took a touch to scroll (`pointercancel`): the drag of
   * the scroll view along the way it moved, until the fingers lift. */
  touchScroll(p, [x, y]) {
    const horizontal = Math.abs(x - p.startX) > Math.abs(y - p.startY);
    const el = p.scrolls.find((v) => !!v._horizontal === horizontal) ?? p.scrolls[0];
    if (el._touchDrag) return;
    el._touchDrag = true;
    el._momentum = false;
    (this.touchDrags ??= new Set()).add(el);
    this.scrollEvent(el, "onScrollDragStart");
    if (!this.touchEndListener) {
      this.touchEndListener = (e) => {
        if (e.touches.length) return;
        for (const v of this.touchDrags) {
          v._touchDrag = false;
          v._released = performance.now();
          this.scrollEvent(v, "onScrollDragEnd");
          // Without a glide no scroll follows (nor, sometimes, `scrollend`).
          setTimeout(() => v._released && !v._momentum && this.scrollEnded(v), 200);
        }
        this.touchDrags.clear();
      };
      window.addEventListener("touchend", this.touchEndListener);
      window.addEventListener("touchcancel", this.touchEndListener);
    }
  }

  /** Momentum after a touch panned a zoomable view (other touch scrolling
   * is the browser's), at `(vx, vy)` points per second. */
  glide(s, vx, vy) {
    let w = Math.abs(vx) > 80 ? vx / 1000 : 0;
    let v = Math.abs(vy) > 80 ? vy / 1000 : 0;
    let last = performance.now();
    const momentum = v !== 0 || w !== 0;
    const end = () => {
      this.drive(s, -1);
      this.snapMarkers(s);
      if (momentum) this.scrollEvent(s, "onMomentumEnd");
      this.ownEnd(s);
    };
    if (!v && !w) {
      end();
      return;
    }
    this.scrollEvent(s, "onMomentumStart");
    const step = (now) => {
      const dt = now - last;
      last = now;
      s.scrollTop += v * dt;
      s.scrollLeft += w * dt;
      v *= Math.pow(0.995, dt);
      w *= Math.pow(0.995, dt);
      if (Math.abs(v) > 0.02 || Math.abs(w) > 0.02) requestAnimationFrame(step);
      else end();
    };
    requestAnimationFrame(step);
  }

  startTwoFinger() {
    const [a, b] = [...this.pointers.values()];
    // A pinch takes over from a pan that moved a scroll view around.
    for (const p of [a, b]) {
      if (!p.handoff) continue;
      for (const axis of [0, 1]) if (p.handoff[axis]) this.releaseHandoff(p.handoff[axis].el, axis, 0);
      p.handoff = [null, null];
    }
    const el = a.pinch ?? b.pinch;
    if (!el) {
      const zoom = a.zoom ?? b.zoom;
      if (zoom) this.startPinchZoom(zoom, a, b);
      return;
    }
    for (const p of [a, b]) this.pressOut(p, false);
    this.twoFinger = { el, dist: Math.hypot(a.x - b.x, a.y - b.y), angle: Math.atan2(b.y - a.y, b.x - a.x) };
    if (el._gestures?.pinch) this.call((w) => w.nsh_transform_gesture(el._id, 0, 0, 1));
    if (el._gestures?.rotation) this.call((w) => w.nsh_transform_gesture(el._id, 1, 0, 0));
  }

  twoFingerAmounts() {
    const [a, b] = [...this.pointers.values()];
    const t = this.twoFinger;
    if (!a || !b) return [t.scale ?? 1, t.rotation ?? 0];
    const scale = Math.hypot(a.x - b.x, a.y - b.y) / Math.max(1, t.dist);
    const rotation = ((Math.atan2(b.y - a.y, b.x - a.x) - t.angle) * 180) / Math.PI;
    t.scale = scale;
    t.rotation = rotation;
    return [scale, rotation];
  }

  /** Two fingers on a zoomable scroll view: the content point between them stays between them as they spread and move. */
  startPinchZoom(el, a, b) {
    for (const p of [a, b]) this.pressOut(p, false);
    cancelAnimationFrame(el._zoomAnimation);
    const [left, top] = this.corner(el, a.layer);
    const fx = (a.x + b.x) / 2 - left;
    const fy = (a.y + b.y) / 2 - top;
    this.twoFinger = { zoom: el, dist: Math.hypot(a.x - b.x, a.y - b.y), scale: el._zoom, point: this.contentPoint(el, fx, fy) };
  }

  moveTwoFinger() {
    const t = this.twoFinger;
    if (t.zoom) {
      const [a, b] = [...this.pointers.values()];
      if (!a || !b) return;
      const [left, top] = this.corner(t.zoom, a.layer);
      t.focus = [(a.x + b.x) / 2 - left, (a.y + b.y) / 2 - top];
      const scale = this.limitZoom(t.zoom, (t.scale * Math.hypot(a.x - b.x, a.y - b.y)) / Math.max(1, t.dist), true);
      this.zoomContent(t.zoom, scale, t.point[0], t.point[1], t.focus[0], t.focus[1]);
      return;
    }
    const [scale, rotation] = this.twoFingerAmounts();
    if (t.el._gestures?.pinch) this.call((w) => w.nsh_transform_gesture(t.el._id, 0, 1, scale));
    if (t.el._gestures?.rotation) this.call((w) => w.nsh_transform_gesture(t.el._id, 1, 1, rotation));
  }

  endTwoFinger() {
    const t = this.twoFinger;
    this.twoFinger = null;
    if (t.zoom) {
      const f = t.focus ?? [t.zoom.clientWidth / 2, t.zoom.clientHeight / 2];
      this.zoomEnded(t.zoom, f[0], f[1]);
      this.pointers.clear();
      return;
    }
    const scale = t.scale ?? 1;
    const rotation = t.rotation ?? 0;
    if (t.el._gestures?.pinch) this.call((w) => w.nsh_transform_gesture(t.el._id, 0, 2, scale));
    if (t.el._gestures?.rotation) this.call((w) => w.nsh_transform_gesture(t.el._id, 1, 2, rotation));
    this.pointers.clear();
  }
}
