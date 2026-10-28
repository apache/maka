// The browser side of nsh's WebAssembly runtime (`nsh-platform-web`):
// loads `nsh.wasm`, runs an app bundle and mounts what the core commits as
// DOM elements. The core lays everything out, so every view is an
// absolutely positioned element at the frame it was given; this file only
// assigns frames and the CSS the Rust side made, draws text runs at their
// laid-out positions, and turns pointer, keyboard and scroll input into
// engine events.
//
//   const player = await createPlayer(container, { wasm: "nsh.wasm" });
//   player.run(await (await fetch("app.js")).text());
//
// Options: `wasm` (its URL, or a `Response` promise), `glue` (the URL of
// the wasm-bindgen glue of a runtime whose crates call JS through
// wasm-bindgen, which the CLI writes next to it; each player imports an
// instance of its own), `assetBase` (where `asset:/<path>` is served) or
// `assets` (a map from `<path>` to its URL, as `nsh package --target web`
// writes it), `readAsset(uri)` (the bytes of an asset the engine needs at
// once, a font: a `Uint8Array` or null), `data` (the URLs of the files the
// runtime fetches when it first needs them, by name, as `nsh package
// --target web` writes them: `{ syntaxes: "nsh-syntaxes.<digest>.bin" }`;
// by default `nsh-<name>.bin` next to this file), `chunks` / `chunkBase`
// (see `run`), `prepareChunk(id)` (a promise for what chunk `id` needs once it
// runs, such as fonts for `readAsset`; awaited with the chunk's download),
// `dark`, `idiom` ("phone", "pad" or "desktop" instead of the one the
// pointer and the viewport suggest), `dialogs` ("viewport": `Dialog`,
// `Sheet` and `AlertDialog` cover the whole window, in the browser's top layer, rather
// than the container, which they cover by default and in browsers without
// popovers), `overlay` (false: no error box), `onError`, `onLog`, `host`
// (the functions `nsh/host`'s `host.call(name, args)` reaches: an object
// whose `call(name, args)` returns the result or a promise of it; a throw
// or a rejection rejects the app's call; without it `host.available()` is
// false). The page sends
// `host.on` listeners events with `player.hostEvent(event, payload)`
// (JSON; it throws when the payload is not); events sent before the app
// runs are delivered, in order, once it starts.
//
// A split bundle (`nsh build --split`) loads its chunks on demand: from
// `chunks[id]` when given (`app.<digest>.js` on a CDN), else `id` relative
// to `chunkBase` (default: the page):
//
//   player.run(code, { chunks: { "Screen.js": "/app.3f2a.js" }, chunkBase });

const ROOT_ID = 1;
const PRESSED = 1;
const HOVERED = 2;
const FOCUSED = 4;
const PRESS_EVENTS = ["onPress", "onLongPress", "onPressIn", "onPressOut"];
const MOUSE_EVENTS = ["onMouseEnter", "onMouseLeave", "onMouseMove"];
/** The DOM's `buttons` bits, in the order a held button is named by. */
const MOUSE_BUTTONS = [[1, "left"], [2, "right"], [4, "middle"], [8, "back"], [16, "forward"]];
/** The keys whose press or release is reported as a mouse move. */
const MODIFIER_KEYS = new Set(["Control", "Alt", "Shift", "Meta"]);
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

/** How far a refreshable scroll view is pulled to refresh, and the room its spinner takes while refreshing (as on Linux and macOS), unless the app draws its own indicator (`refreshIndicator`: its height is both). */
const REFRESH_PULL = 64;
const REFRESH_SPACE = 56;
/** Desktop scroll bars (`showBar`): thickness, margin, the band along the
 * edge a press grabs (points), and how long a shown bar stays (ms). */
const BAR_THICK = 4;
const BAR_MARGIN = 2;
const BAR_GRAB = 12;
const BAR_HOLD = 700;

/* Keyframe animations (animate-spin, -ping, -pulse, -bounce) run with
   animation-composition: add: their transforms follow the view's own (as the
   native backends apply them), and --nsh-ko is added to 1 to make the factor
   the view's opacity is multiplied by (opacity: calc(<opacity> * var(--nsh-ko))). */
/** Screen motion (the Linux backend's): a push or pop slides for SLIDE_MS
 * while the screen under it moves by PARALLAX of the width, a fade takes
 * FADE_MS, both easing out cubically (1 - (1 - t)^3, exactly). */
const SLIDE_MS = 300;
const FADE_MS = 200;
const PARALLAX = 0.3;
const EASE_OUT_CUBIC = "cubic-bezier(0.333,1,0.667,1)";
/** How far back a pointer's velocity is measured (ms). */
const VELOCITY_WINDOW = 100;

/** View kinds whose frames, appearing and disappearing are navigation's. */
const NAVIGATED = new Set(["stack", "screen", "modal", "header", "accessory"]);

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
.nsh-v:focus { outline: none; }
.nsh-v:focus-visible { outline: 2px solid var(--nsh-focus-ring, #0a84ff); outline-offset: -2px; }
.nsh-scroll { overflow: auto; overscroll-behavior: contain; -webkit-overflow-scrolling: touch; }
.nsh-scroll { touch-action: pan-x pan-y; }
/* In an iframe, swipes the app does not take scroll the embedding page. */
.nsh-root.nsh-embedded { touch-action: pan-x pan-y; }
/* Views with native pans: none, or the other axis's scrolling. */
.nsh-pan { touch-action: none; }
.nsh-pan-x { touch-action: pan-y; }
.nsh-pan-y { touch-action: pan-x; }
.nsh-live { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
/* Scroll indicators: a thin, translucent thumb with no track, as on phones,
   rather than the platform's scrollbar (with arrow buttons on Windows).
   Chromium ignores the pseudo-elements once scrollbar-width / scrollbar-color
   are set, so those are only for browsers without them (Firefox). */
.nsh-scroll::-webkit-scrollbar { width: 6px; height: 6px; }
.nsh-scroll::-webkit-scrollbar-track, .nsh-scroll::-webkit-scrollbar-corner { background: transparent; }
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
.nsh-run { position: absolute; white-space: pre; }
.nsh-run-bg { position: absolute; pointer-events: none; }
.nsh-border { position: absolute; inset: 0; pointer-events: none; }
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
/* A sticky list cell's range of travel (op_sticky): it lifts the cell above the other cells, and with no breadth
   across it takes no pointer events. The cell sticks inside it, at its left in either direction. */
.nsh-track { position: absolute; z-index: 5; }
.nsh-track > .nsh-v { position: sticky; margin-right: auto; }
/* A list with sticky cells keeps their z-index to itself: above its other cells, never over the views after it. */
.nsh-sticky { isolation: isolate; }
.nsh-fill { position: absolute; left: 0; top: 0; width: 100%; height: 100%; border: 0; }
img.nsh-fill { pointer-events: none; }
.nsh-shader { pointer-events: none; border-radius: inherit; }
.nsh-fit-cover { object-fit: cover; }
.nsh-fit-contain { object-fit: contain; }
.nsh-fit-fill { object-fit: fill; }
.nsh-fit-scale-down { object-fit: scale-down; }
.nsh-fit-none { object-fit: none; }
.nsh-spacer { position: absolute; left: 0; top: 0; width: 1px; height: 1px; pointer-events: none; visibility: hidden; }
/* Over the style's \`overflow: clip\`. */
.nsh-scroll.nsh-ox.nsh-ox { overflow-x: auto; overflow-y: hidden; }
.nsh-scroll.nsh-oy.nsh-oy { overflow-x: hidden; overflow-y: auto; }
.nsh-scroll.nsh-oxy.nsh-oxy { overflow: auto; }
.nsh-scroll.nsh-onone.nsh-onone { overflow: hidden; }
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
.nsh-dialog-backdrop { position: absolute; inset: 0; background: rgba(0,0,0,.35); display: flex;
  align-items: center; justify-content: center; z-index: 1000; }
.nsh-dialog { width: 270px; border-radius: 14px; background: rgba(245,245,245,.97); color: #000; text-align: center;
  font: 13px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; overflow: clip; }
.nsh-dialog h3 { font-size: 17px; font-weight: 600; margin: 18px 16px 4px; }
.nsh-dialog p { margin: 0 16px 18px; }
.nsh-dialog button { display: block; width: 100%; border: 0; border-top: 0.5px solid rgba(0,0,0,.2); background: none;
  font: 17px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: #007aff; padding: 11px; cursor: pointer; }
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
.nsh-sheet button { display: block; width: 100%; border: 0; background: none; padding: 16px; cursor: pointer;
  font: 19px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: #007aff; }
.nsh-sheet button + button { border-top: 0.5px solid rgba(0,0,0,.2); }
.nsh-sheet button.cancel { font-weight: 600; }
.nsh-sheet button.destructive { color: #ff3b30; }
.nsh-dark .nsh-sheet > div { background: rgba(44,44,46,.97); color: #fff; }
.nsh-dark .nsh-sheet button { color: #0a84ff; border-top-color: rgba(255,255,255,.15); }
.nsh-dark .nsh-sheet button.destructive { color: #ff453a; }
.nsh-desktop .nsh-sheet > div { border-radius: 12px; padding: 6px; background: #fff; color: #0a0a0a; border: 1px solid #e5e5e5;
  box-shadow: 0 10px 30px rgba(0,0,0,.25); }
.nsh-desktop .nsh-sheet .nsh-sheet-head { color: #737373; border-bottom: 1px solid #e5e5e5; margin-bottom: 4px; padding: 8px 12px 12px; }
.nsh-desktop .nsh-sheet button { border: 0; border-radius: 8px; padding: 11px 16px; font-size: 16px; color: inherit; }
.nsh-desktop .nsh-sheet button:hover { background: rgba(128,128,128,.12); }
.nsh-desktop .nsh-sheet button.destructive { color: #ef4444; }
.nsh-desktop.nsh-dark .nsh-sheet > div { background: #171717; color: #fafafa; border-color: #262626; }
.nsh-desktop.nsh-dark .nsh-sheet .nsh-sheet-head { color: #a3a3a3; border-bottom-color: #262626; }
.nsh-desktop.nsh-dark .nsh-sheet button.destructive { color: #f87171; }
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
  padding: 4px 12px; cursor: pointer; }
.nsh-error-copy:hover { background: rgba(255,255,255,.2); }
`;

/** An Apple keyboard: Command is the shortcut key, Option+Left moves by word. */
const APPLE = /mac|iphone|ipad/i.test(navigator.userAgentData?.platform ?? navigator.platform);

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

/**
 * The browser's offset of local time from UTC at `ms` (ms since the epoch),
 * in seconds east, as `struct tm`'s `tm_gmtoff` holds it (`local_time.rs`):
 * daylight saving time included; 0 for a time the browser cannot place.
 */
function localOffset(ms) {
  const west = new Date(ms).getTimezoneOffset();
  return Number.isFinite(west) ? 0 - west * 60 : 0;
}

/** The browser's time zone (`Asia/Shanghai`), Intl's default; "" when unknown. */
function timeZoneName() {
  return new Intl.DateTimeFormat().resolvedOptions().timeZone ?? "";
}

/**
 * The key of a key event as `nsh_key` takes it (-1: none): the character
 * it types without modifiers, or, when Shift or Option change it or the
 * layout types no ASCII there, the US layout's character of the same key
 * (shortcuts work on any layout, as menus' do).
 */
function keyCode(e) {
  const named = NAMED_KEYS[e.key];
  if (named) return named;
  const f = /^F([0-9]{1,2})$/.exec(e.key);
  if (f) return Number(f[1]) >= 1 && Number(f[1]) <= 24 ? 512 + Number(f[1]) : -1;
  const k = e.key;
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

/** The sheet of the generated classes (`nsh-classes`), after the runtime's
 * own rules, or of the views' own rules (`nsh-own`): changing a rule makes
 * the browser go over its whole sheet again, so those that change are
 * apart. */
function classSheet(id) {
  if (!CLASSES.sheets[id]) {
    const style = document.createElement("style");
    style.id = id;
    document.head.append(style);
    CLASSES.sheets[id] = style.sheet;
  }
  return CLASSES.sheets[id];
}

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
function importGlue(url) {
  const href = new URL(String(url), document.baseURI);
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
    if (event.source !== frame.contentWindow || event.data !== "nsh:viewport" || !event.ports[0]) return;
    const port = event.ports[0];
    let release;
    const close = () => { release?.(); release = null; port.close(); leases.delete(close); };
    try {
      const lease = frameViewport(frame);
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
function frameViewport(frame) {
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
    outer = frameViewport(parentFrame);
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
    "border-radius": "0", "clip-path": "none", background: "transparent", margin: "0", border: "0", padding: "0", transform: "none", "box-sizing": "border-box" })) {
    frame.style.setProperty(name, value, "important");
  }
  try { frame.showPopover(); } catch (error) {
    if (saved === null) frame.removeAttribute("style"); else frame.setAttribute("style", saved);
    if (popover === null) frame.removeAttribute("popover"); else frame.setAttribute("popover", popover);
    placeholder?.remove(); outer?.release(); throw error;
  }
  const unlock = lockViewportPage(frame);
  frame.focus({ preventScroll: true });
  const state = frame._nshViewport = { users: 1, rect, release() {
    if (frame._nshViewport !== state || --state.users) return;
    observer.disconnect();
    frame.hidePopover();
    if (saved === null) frame.removeAttribute("style"); else frame.setAttribute("style", saved);
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
    this.assetBase = options.assetBase ?? "";
    this.container = container;
    if (!document.getElementById("nsh-style")) {
      const style = document.createElement("style");
      style.id = "nsh-style";
      style.textContent = KEYFRAMES;
      document.head.append(style);
    }
    this.root = document.createElement("div");
    this.root.className = window.top === window ? "nsh-root" : "nsh-root nsh-embedded";
    // Its size is in the class: the core styles the root too (a
    // right-to-left layout), which replaces its inline style.
    container.append(this.root);
    this.views = new Map();
    this.mouseTracked = new Set();
    // Shader views (`op_sh`), drawn on one WebGL 2 context (`shaderGl`).
    this.shaderViews = new Set();
    // Of the views' own style rules (`op_css`).
    this.classPrefix = `nsh-p${++players}-`;
    this.timer = 0;
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
    // Views removed by the batch being applied (`finishRemovals`).
    this.removals = [];
    this.images = new Map();
    // Browser blob URLs of the in-memory images (`data:` URIs, blobs) the
    // views show, by the source's URI (`image_bytes`).
    this.inlineImages = new Map();
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
    // Host events sent before the app runs (`begin`).
    this.hostEvents = [];
    if (window.top === window) document.documentElement.classList.add("nsh-page");
  }

  async load(url) {
    // An app's crates that call JS through wasm-bindgen (web-sys, js-sys):
    // the CLI ran `wasm-bindgen --target web` on the runtime, and its glue
    // provides the module's other imports. It loads while the module
    // compiles; a failed compile does not leave its rejection unhandled.
    const glueLoad = this.options.glue ? importGlue(this.options.glue) : null;
    glueLoad?.catch(() => {});
    const imports = {
      env: {
        __rquickjs_host_now_us: () => Date.now() * 1000,
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
        // QuickJS' local time (`local_time.rs`) and Intl's default zone.
        local_offset: (ms) => localOffset(ms),
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
        register_font: (fp, fl, dp, dl, weight, italic) => {
          const family = this.str(fp, fl);
          const data = this.bytes(dp, dl).slice();
          const face = new FontFace(family, data, { weight: String(weight), style: italic ? "italic" : "normal" });
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
          this.inlineImages.set(uri, URL.createObjectURL(new Blob([this.bytes(dp, dl).slice()], { type })));
        },
        release_image: (p, l) => {
          const uri = this.str(p, l);
          const url = this.inlineImages.get(uri);
          if (url) URL.revokeObjectURL(url);
          this.inlineImages.delete(uri);
        },
        submit: (p, l) => {
          const batch = JSON.parse(this.str(p, l));
          const retired = this.apply(batch);
          this.submitResult = retired.length ? encoder.encode(JSON.stringify(retired)) : null;
          return this.submitResult?.length ?? 0;
        },
        submit_result: (p, l) => {
          this.bytes(p, l).set(this.submitResult);
          this.submitResult = null;
        },
        request_frame: () => this.requestFrame(),
        request_pump: () => this.requestPump(),
        report_error: (p, l) => this.showError(this.str(p, l)),
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
        fetch_start: (id, mp, ml, up, ul, hp, hl, bp, bl, kind, follow) =>
          this.fetchStart(id, this.str(mp, ml), this.str(up, ul), JSON.parse(this.str(hp, hl)),
            kind === 1 ? this.bytes(bp, bl).slice() : null, kind === 2, follow !== 0),
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
        websocket_cancel: (id) => this.websocketCancel(id),
        load_chunk: (p, l) => this.loadChunk(this.str(p, l)),
        load_data: (p, l) => this.loadData(this.str(p, l)),
        // The app's storage (`nsh/storage`): the entries of `localStorage`
        // under the app's prefix. 1 when done, 0 when the browser refused
        // (the error handed over with `nsh_storage_reply`).
        storage_load: (pp, pl) => this.storage(() => {
          const prefix = this.str(pp, pl);
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
    // The glue's own setup (its view of the memory, wasm-bindgen's tables)
    // before any of the app's code runs.
    glue?.__nsh_finalize(instance, module);
    // An app's own runtime (Rust components: nsh.json "rust") registers
    // its UI sets before anything starts.
    this.wasm.nsh_app_init?.();
    // Relative request URLs (`fetch("/api")`) are the page's, as in the browser.
    this.withStrings([document.baseURI], (p, l) => this.wasm.nsh_set_base_url(p, l));
    new ResizeObserver(() => this.resized()).observe(this.root);
    matchMedia("(prefers-color-scheme: dark)").addEventListener("change", (e) => {
      if (this.options.dark === undefined) this.setDark(e.matches);
    });
    this.installEnvironment();
    this.installInput();
  }

  // Tests ---------------------------------------------------------------

  /**
   * A test session runs (`nsh test --target web`): the module keeps the
   * model of the app its agent asks about, from the next bundle on.
   */
  testStart() {
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
      m = [t.fontBoundingBoxAscent ?? 0, t.fontBoundingBoxDescent ?? 0, x.actualBoundingBoxAscent ?? 0];
      this.metricsCache.set(font, m);
    }
    return m;
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
      const waiting = this.fontsPending;
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
   * Runs `code` (a bundle from `nsh build`: `bundle.js` as a string, or its
   * bytecode `bundle.nshc` as an `ArrayBuffer` / `Uint8Array`, the only
   * form the runtime of published apps runs), replacing what ran. Options:
   * `release` (hardened, as packaged apps run; default: development
   * settings), `harden` (with bytecode: the hardening's bytecode the CLI
   * ships, `harden.nshc`), `capabilities` (the app's `capabilities.json`),
   * `sourceMap` (JSON), `appId` (`nsh.json` `"id"`: the app's storage is
   * kept under it; without one, under the page's path), `limits` (the VM
   * limits the page runs the app with, as an app embedding it sets them:
   * `"memory=128MB,call=2s"`, `""` for the embedding defaults; without it
   * the app runs on its own, with none), and where a split bundle's chunks are: `chunks[id]`
   * (a URL), else `id` relative to `chunkBase` (default: the page); the
   * chunks of a bytecode bundle are bytecode too. Static entry dependencies
   * are supplied as preloadedChunks[id] (source or bytecode).
   */
  run(code, {
    release = false,
    harden = null,
    capabilities = "",
    sourceMap = "",
    appId = "",
    limits = null,
    preloadedChunks = {},
    chunks = this.options.chunks,
    chunkBase = this.options.chunkBase,
  } = {}) {
    if (code instanceof ArrayBuffer) code = new Uint8Array(code);
    const bytecode = typeof code !== "string";
    const [width, height] = this.reset();
    this.chunks = { map: chunks ?? {}, base: chunkBase ?? document.baseURI, bytecode };
    this.call(() => this.withStrings([capabilities ?? "", sourceMap ?? "", appId ?? ""], (cp, cl, mp, ml, ip, il) =>
      this.wasm.nsh_bundle_options(release ? 1 : 0, cp, cl, mp, ml, ip, il)));
    for (const [id, source] of Object.entries(preloadedChunks)) {
      const bytes = source instanceof ArrayBuffer ? new Uint8Array(source) : source;
      this.call(() => this.withStrings([id, bytes], (np, nl, cp, cl) =>
        this.wasm.nsh_bundle_chunk(np, nl, cp, cl, typeof bytes === "string" ? 0 : 1)));
    }
    if (harden) this.call(() => this.withStrings([new Uint8Array(harden)], (p, l) => this.wasm.nsh_bundle_harden(p, l)));
    if (limits != null) this.call(() => this.withStrings([limits], (p, l) => this.wasm.nsh_bundle_limits(p, l)));
    this.begin(width, (environment) => {
      this.withStrings([environment], (p, l) => this.wasm.nsh_environment(p, l));
      const start = bytecode ? this.wasm.nsh_start_bytecode : this.wasm.nsh_start;
      return this.withStrings([code], (p, l) =>
        start(p, l, width, height, this.dark ? 1 : 0, devicePixelRatio || 1));
    });
  }

  /** Runs a trusted standalone app with the browser ES module loader. */
  runModule(entry, options) {
    if (!this.browserHost) throw new Error("this runtime has no browser JavaScript host");
    return this.browserHost.run(entry, options);
  }

  /**
   * Runs the Rust app the module was built for (an app's runtime with
   * `nsh.json` `"root"`): its root component, with no bundle and no JS of
   * the app's, replacing what ran.
   */
  runRust() {
    if (!this.wasm.nsh_start_rust) throw new Error("this runtime has no Rust app");
    const [width, height] = this.reset();
    this.chunks = { map: {}, base: document.baseURI, bytecode: false };
    this.begin(width, (environment) => {
      this.withStrings([environment], (p, l) => this.wasm.nsh_environment(p, l));
      return this.wasm.nsh_start_rust(width, height, this.dark ? 1 : 0, devicePixelRatio || 1);
    });
  }

  /** Stops what ran and empties the root; its size. */
  reset() {
    this.stop();
    this.resetHistory();
    this.app = (this.app ?? 0) + 1;
    const root = this.root;
    root.textContent = "";
    root.append(this.live);
    this.views.clear();
    this.mouseTracked.clear();
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
    this.idiom = this.options.idiom ?? this.measureIdiom(width);
    const environment = (this.reported = JSON.stringify(this.environment()));
    this.updateRootClasses();
    // Host events wait for this app's top-level `host.on` listeners, not
    // the replaced app's; those queued after a failed start are dropped.
    this.started = false;
    this.hostEvents ??= [];
    // Fonts registered while it starts hold its first frame back (`fontLoading`).
    this.starting = true;
    try {
      this.call(() => start(environment));
    } catch (err) {
      // Only a trap (a panic) throws: no app runs to take events.
      this.hostEvents = null;
      throw err;
    } finally {
      this.starting = false;
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

  /** Fetches chunk `id` of the running bundle and hands it to the engine. */
  async loadChunk(id) {
    const { map, base, bytecode } = this.chunks;
    const app = this.app;
    let code;
    let ok = bytecode ? 2 : 1;
    // `nsh build --split` writes a chunk's bytecode next to it: `Screen.nshc`.
    const url = map[id] ?? (bytecode ? id.replace(/\.js$/, ".nshc") : id);
    try {
      // What the chunk needs synchronously once it runs (its fonts), from
      // the page, alongside it.
      const [response] = await Promise.all([fetch(new URL(url, base)), this.options.prepareChunk?.(id)]);
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`.trim());
      code = bytecode ? new Uint8Array(await response.arrayBuffer()) : await response.text();
    } catch (err) {
      code = `${err.message ?? err} (${url})`;
      ok = 0;
    }
    // A chunk of an app that was replaced meanwhile is dropped.
    if (app !== this.app) return;
    this.call((w) => this.withStrings([id, code], (ip, il, cp, cl) => w.nsh_chunk(ip, il, cp, cl, ok)));
  }

  /**
   * Fetches the runtime's data `name` (`nsh-<name>.bin`, or the URL
   * `data[name]` names) and hands it to the engine; a file that is missing
   * or does not load is handed over as none (the code it would highlight
   * stays plain).
   */
  async loadData(name) {
    const url = this.options.data?.[name] ?? new URL(`nsh-${name}.bin`, import.meta.url);
    let bytes = null;
    try {
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
   * Compiles one TSX module to what `run` takes, in the page (only with
   * `nsh-playground.wasm`): `{ code }` or `{ error }` (with a code frame).
   */
  compile(source, name = "App.tsx") {
    if (!this.wasm.nsh_compile) return { error: "this runtime has no compiler (load nsh-playground.wasm)" };
    const ok = this.withStrings([name, source], (np, nl, sp, sl) => this.wasm.nsh_compile(np, nl, sp, sl));
    const text = this.str(this.wasm.nsh_compiled_ptr(), this.wasm.nsh_compiled_len());
    return ok ? { code: text } : { error: text };
  }

  /** Compiles and runs `source` (with `run`'s `options`); the compile error, or null. */
  runSource(source, name = "App.tsx", options = {}) {
    const result = this.compile(source, name);
    if (result.error) return result.error;
    this.run(result.code, options);
    return null;
  }

  /**
   * Applies a hot update from the dev server (a script replacing changed
   * modules) to the running app. Returns false when it could not be
   * applied in place: run the new bundle instead.
   */
  hotUpdate(code, name = "hot.js", sourceMap = "") {
    let applied = true;
    this.call(() => {
      const delay = this.withStrings([name, code, sourceMap ?? ""], (np, nl, cp, cl, mp, ml) =>
        this.wasm.nsh_hot_update(np, nl, cp, cl, mp, ml));
      applied = !this.wasm.nsh_hot_failed();
      return delay;
    });
    return applied;
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
    this.fileOperations.clear();
    for (const id of [...this.requests.keys()]) this.fetchCancel(id);
    for (const id of [...this.websockets.keys()]) this.websocketCancel(id);
    clearTimeout(this.timer);
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.browserHost?.stop();
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
   * applied) waits until it returns.
   */
  call(f) {
    if (this.depth > 0) {
      (this.deferred ??= []).push(f);
      return;
    }
    this.depth = 1;
    try {
      this.schedule(f(this.wasm));
    } finally {
      this.depth = 0;
    }
    const deferred = this.deferred;
    if (deferred?.length) {
      this.deferred = [];
      for (const g of deferred) this.call(g);
    }
  }

  requestFrame() {
    if (this.frame) return;
    this.frame = requestAnimationFrame((now) => {
      this.frame = 0;
      this.call((w) => w.nsh_frame(now));
    });
  }

  resized() {
    const width = this.root.clientWidth;
    const height = this.root.clientHeight;
    if (!this.size || !width || (width === this.size[0] && height === this.size[1])) return;
    this.size = [width, height];
    this.call((w) => w.nsh_resize(width, height));
    this.environmentChanged();
    for (const el of this.views.values()) if (el._kind === "modal" && el.isConnected && !el._leaving) this.placeModal(el);
  }

  // Environment ---------------------------------------------------------

  /**
   * The kind of device, decided when an app starts (it never changes while
   * it runs, as on every platform): a mouse (a fine pointer that hovers)
   * and a viewport at least 600 wide make a desktop, a touch screen whose
   * short side is at least 600 a tablet, the rest a phone.
   */
  measureIdiom(width) {
    if (matchMedia("(pointer: fine) and (hover: hover)").matches && width >= 600) return "desktop";
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
    visualViewport?.addEventListener("resize", changed);
    visualViewport?.addEventListener("scroll", changed);
    new MutationObserver(changed).observe(document.documentElement, { attributes: true, attributeFilter: ["dir", "lang"] });
    // `env(safe-area-inset-*)` is only readable through a style it sets.
    this.safeProbe = document.createElement("div");
    this.safeProbe.className = "nsh-probe";
    document.body.append(this.safeProbe);
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
      rtl: dir === "rtl" || dir === "ltr" ? dir === "rtl" : rightToLeft(locale),
      reduceMotion: this.reducedMotion.matches,
      fontScale: Math.round(fontSize / 16 * 100) / 100,
      pixelRatio: devicePixelRatio || 1,
      safeArea: this.safeArea(),
      keyboard: this.keyboardHeight(),
      appleKeyboard: APPLE,
      host: Boolean(this.options.host),
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

  showError(message) {
    console.error("[nsh]", message);
    this.options.onError?.(message);
    if (this.options.overlay === false) return;
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

  asset(uri) {
    if (!uri) return uri;
    if (uri.startsWith("asset:/")) {
      const path = uri.slice("asset:/".length).replace(/^\/+/, "");
      return this.options.assets?.[path] ?? this.assetBase + path;
    }
    // An in-memory image: its bytes came with `image_bytes`.
    return this.inlineImages.get(uri) ?? uri;
  }

  // Mounting ------------------------------------------------------------

  apply(batch) {
    const retired = [];
    for (const item of batch) {
      const handler = this[`op_${item[0]}`];
      if (handler) {
        const result = handler.call(this, item);
        if (item[0] === "rc") retired.push(result);
      }
    }
    this.endLayoutAnimation();
    if (this.changedStacks.size) this.reconcileStacks();
    if (this.removals.length) this.finishRemovals();
    return retired;
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
      // The user takes over a smooth scroll of the core's (`op_sb`).
      const takeOver = () => { el._smooth = null; };
      for (const type of ["wheel", "pointerdown", "touchstart", "keydown"]) el.addEventListener(type, takeOver, { passive: true });
    }
    if (kind === "screen") el.classList.add("nsh-screen");
    if (kind === "modal") el.classList.add("nsh-modal");
    if (kind === "stack") el.classList.add("nsh-clip");
    if (this.layoutAnimation?.create) this.appearing.push(el);
    this.views.set(id, el);
  }

  op_pr([, parentId, id, following]) {
    const parent = this.view(parentId);
    const child = this.view(id);
    if (!parent || !child) return;
    // Modal windows have their own presentation lifetime and global order;
    // their logical siblings do not describe that native stack.
    if (child._kind === "modal") {
      this.op_i(["i", parentId, id, null]);
      return;
    }
    const host = parent._layer ?? parent;
    const before = following.map((sibling) => this.view(sibling)).find((view) =>
      view && view !== child && (view._track ?? view).parentNode === host);
    this.op_i(["i", parentId, id, before?._id ?? null]);
    if (child._kind === "header" && child.parentNode === host) {
      this.insertView(host, child, before?._track ?? before ?? null);
    }
  }

  insertView(host, child, before) {
    if (child.parentNode === host && child.nextSibling === before) return;
    host.insertBefore(child, before);
  }

  op_i([, parentId, childId, beforeId]) {
    const parent = this.view(parentId);
    const child = this.view(childId);
    if (!parent || !child) return;
    const retired = child._listRetired;
    if (retired) {
      child._listRetired = false;
      child.inert = false;
    }
    if (child._kind === "modal") {
      if (retired) {
        // A cancelled retirement restores the existing SDK presentation slot.
        const before = [...this.root.children].find((view) => view._kind === "modal" && view._modalOrder > child._modalOrder);
        this.insertView(this.root, child, before ?? null);
        this.placeModal(child);
        this.scopeFocus();
        this.syncHistorySoon();
      } else if (child.parentNode !== this.root || child._leaving) this.present(child);
      return;
    }
    const beforeView = beforeId == null ? null : this.view(beforeId);
    const before = beforeView?._track ?? beforeView;
    if (child._kind === "header") {
      child._headerParent = parent;
      if (retired) for (const screen of this.views.values()) {
        if (screen._screen?.header === childId) this.placeHeader(screen);
      }
      return;
    }
    // Back before its removal finished animating.
    if (child._dying) this.revive(child);
    child._removedFrom = null;
    child._removing = false;
    child._leftWith = null;
    const host = parent._layer ?? parent;
    const projection = child._track ?? child;
    if (projection !== child && child.parentNode !== projection) projection.append(child);
    this.insertView(host, projection, before && before.parentNode === host ? before : null);
    if (parent._kind === "stack") {
      if (retired) {
        this.resetStack(parent);
        if (parent._frame) this.reportRoot(child, parent._frame[2], parent._frame[3], this.screenInsets(child));
      } else {
        this.changedStacks.add(parent);
        this.stackChanged(parent, child);
      }
    }
    if (retired) this.scopeFocus();
  }

  op_r([, id]) {
    const el = this.view(id);
    if (!el) return;
    // A source removal ends a previously parked projection, not a new ACK.
    if (el._listRetired) { el._listRetired = false; el.inert = false; }
    if (el._kind === "modal") {
      this.dismiss(el);
      return;
    }
    const parent = el.parentNode;
    const focused = el.contains(document.activeElement);
    this.detach(el, parent);
    if (parent?._kind === "stack") this.stackChanged(parent);
    this.screenGone(el, focused);
  }

  op_rc([, id, request, rootIds]) {
    const result = { id, request, retired: true, focus: this.focusPath(), cancelled: [], states: [] };
    if (rootIds.some((root) => result.focus.includes(root))) {
      result.retired = false;
      return result;
    }
    // Detach immediately: a pooled cell must stop taking input and Tab
    // before its old item can be rebound, regardless of exit animations.
    const roots = rootIds.map((root) => this.view(root)).filter(Boolean);
    for (const root of roots) {
      root._listRetired = true;
      root.inert = true;
    }
    Object.assign(result, this.cancelInput(roots));
    for (const root of roots) {
      for (const view of [root, ...root.querySelectorAll(".nsh-v")]) {
        clearTimeout(view._modalDismissTimer);
        view._modalDismissTimer = 0;
        if (view._kind === "modal") {
          view._entering = view._leaving = false;
          view._closed = false;
          view._restoreFocus = null;
          view.style.transition = "";
          view.style.transform = "";
          view.style.opacity = "";
        }
        if (view._kind === "screen") {
          view._popping = false;
          view._removedFrom = null;
          view._restoreFocus = null;
          view.style.pointerEvents = "";
          view.style.visibility = "";
        }
      }
      const projection = root._track ?? root;
      const parent = projection.parentNode;
      projection.remove();
      if (parent?._kind === "stack") this.resetStack(parent);
    }
    this.scopeFocus();
    this.syncHistorySoon();
    result.focus = this.focusPath();
    return result;
  }

  // Retirement alone must revoke the old cell's native captures before ACK.
  cancelInput(roots) {
    const result = { cancelled: [], states: [] };
    const contains = (view) => view && roots.some((root) => root.contains(view));
    const states = new Map();
    const cancelPress = (p) => {
      clearTimeout(p.longTimer);
      p.pressed = false;
      for (const view of p.states) {
        view._states &= ~PRESSED;
        states.set(view._id, view._states);
      }
    };
    if (contains(this.keyPress?.press)) {
      cancelPress(this.keyPress);
      this.keyPress = null;
    }
    if (contains(this.wheelPinchState?.el)) {
      clearTimeout(this.wheelPinchState.timer);
      this.wheelPinchState = null;
    }
    if (contains(this.gesture)) this.gesture = null;
    if (contains(this.wheelLock?.el)) this.wheelLock = null;
    for (const root of roots) {
      for (const view of [root, ...root.querySelectorAll(".nsh-v")]) {
        clearTimeout(view._autoFocusTimer);
        view._autoFocusTimer = null;
        cancelAnimationFrame(view._modalEnterFrame);
        clearTimeout(view._modalShowTimer);
        view._modalEnterFrame = view._modalShowTimer = 0;
        for (const animation of view.getAnimations?.() ?? []) {
          animation.onfinish = null;
          animation.cancel();
        }
        if (view._frameAnimation) {
          view._frameAnimation.onfinish = null;
          view._frameAnimation.cancel();
        }
        view._frameAnimation = null;
        if (view._kind === "stack") clearTimeout(view._hideTimer);
        if (view._kind !== "scroll") continue;
        clearTimeout(view._wheelZoomTimer);
        view._wheelZoomTimer = null;
        view._cancelPull?.();
        cancelAnimationFrame(view._pullAnimation);
        view._pullAnimation = 0;
        cancelAnimationFrame(view._zoomAnimation);
        view._zoomAnimation = 0;
        if (view._glide) {
          clearTimeout(view._glide.timer);
          cancelAnimationFrame(view._glide.frame);
          view._glide = null;
          this.drive(view, -1);
        }
        if (view._momentumFrame) {
          cancelAnimationFrame(view._momentumFrame);
          view._momentumFrame = 0;
          this.drive(view, -1);
        }
        clearTimeout(view._touchEndTimer);
        view._touchEndTimer = null;
        this.touchDrags?.delete(view);
        view._touchDrag = false;
        view._released = 0;
        view._momentum = false;
        view._ownEnd = null;
        view._smooth = null;
        view._restoreSnap = false;
        view.style.scrollSnapType = "";
        view.scrollTo({ left: view.scrollLeft, top: view.scrollTop, behavior: "instant" });
      }
    }
    const twoFingerOwner = this.twoFinger && (this.twoFinger.el ?? this.twoFinger.zoom);
    for (const [contact, p] of [...this.pointers]) {
      const owner = twoFingerOwner ?? (p.mode === "pan" ? p.pan : p.mode === "bar" || p.mode === "scroll" ? p.scroll : null);
      if (!contains(p.target ?? p.scroll) && !contains(owner)) continue;
      cancelPress(p);
      if (p.touchPath.length) result.cancelled.push(contact);
      p.touchPath = [];
      p.press = null;
      p.states = [];
      if (owner && !contains(owner)) {
        // The row's touch and press ended, but an ancestor that already
        // took over the gesture still owns its native drag or pinch.
        p.target = null;
        if (contains(p.pan)) p.pan = null;
        if (contains(p.scroll)) p.scroll = null;
        if (p.scrolls) p.scrolls = p.scrolls.filter((view) => !contains(view));
        if (contains(p.zoom)) p.zoom = null;
        if (contains(p.pinch)) p.pinch = null;
        if (contains(p.gate)) {
          p.gate = null;
          p.gateState = 0;
        }
        continue;
      }
      this.pointers.delete(contact);
      if (p.mode === "bar" || p.mode === "scroll") {
        this.drive(p.scroll, -1);
        if (p.mode === "bar") {
          p.scroll._barHeld = false;
          p.scroll.style.scrollSnapType = "";
        }
      }
    }
    if (contains(twoFingerOwner)) this.twoFinger = null;
    result.states = [...states];
    return result;
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
    if (el._shader) this.op_sh([, id, null]);
    if (el._video) {
      // A removed media element keeps playing until it is collected.
      clearInterval(el._progressTimer);
      el._video.pause();
      el._video.removeAttribute("src");
      el._video.load();
    }
    if (el._kind === "modal") {
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
    el._frame = [x, y, w, h];
    this.placeFrame(el);
    if (from && from.some((v, i) => v !== el._frame[i])) {
      const box = (f) => ({ left: `${f[0]}px`, top: `${f[1]}px`, width: `${f[2]}px`, height: `${f[3]}px` });
      const a = this.animateLayout(el, [box(from), box(el._frame)], update);
      a.onfinish = () => { if (el._frameAnimation === a) el._frameAnimation = null; };
      el._frameAnimation = a;
    }
    if (el._kind === "canvas") this.drawSoon(el);
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
  op_s([, id, css, border, tint]) {
    const el = this.view(id);
    if (!el) return;
    swapClass(el, "_class", this.styleClass(css));
    if (border) {
      if (!el._border) el._border = document.createElement("div");
      el._border.className = `nsh-border ${this.styleClass(border)}`;
      if (el._animation["border-color"]) el._border.style.borderColor = el._animation["border-color"];
      el.append(el._border);
    } else if (el._border) {
      el._border.remove();
      el._border = null;
    }
    if (el._kind === "image") {
      el._tint = tint;
      this.applyTint(el);
    }
  }

  op_a([, id, prop, value]) {
    const el = this.view(id);
    if (!el) return;
    if (prop.startsWith("canvas:") && el._shader) {
      this.shaderSlot(el, Number(prop.slice(7)), value);
      return;
    }
    if (prop.startsWith("canvas:")) {
      el._slots[Number(prop.slice(7))] = isNaN(Number(value)) ? value : Number(value);
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

  op_t([, id, cx, cy, , , runs, styles, selectable, selection, backgrounds, links]) {
    const el = this.view(id);
    if (!el) return;
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
    for (const [x, y, text, style, start, parts, after] of runs) {
      const span = document.createElement("span");
      const name = this.styleClass(styles[style]);
      span.className = name ? `nsh-run ${name}` : "nsh-run";
      span.style.cssText = `left:${cx + x}px;top:${cy + y}px`;
      fillRun(span, text, parts, spans);
      // Where its characters are in the text (UTF-16, as JS strings).
      span._start = start;
      // The line's break, for copying (`copy`).
      if (after) span._after = after;
      if (el._animation.color) span.style.color = el._animation.color;
      frag.append(span);
    }
    for (const span of [...el.querySelectorAll(":scope > .nsh-run, :scope > .nsh-run-bg")]) span.remove();
    el.insertBefore(frag, el.firstChild);
    el.classList.toggle("nsh-selectable", !!selectable);
    el.classList.toggle("nsh-autoselect", selectable == null);
    el.classList.toggle("nsh-noselect", selectable === false);
    // Its `--nsh-selection`.
    swapClass(el, "_selection", this.styleClass(selection));
    el._textLabel = runs.map((r) => r[2]).join("");
    if (el._props?.label == null) el.setAttribute("aria-label", el._textLabel);
  }

  op_e([, id, events]) {
    const el = this.view(id);
    if (!el) return;
    el._events = new Set(events);
    if (el._events.has("onMouseMove")) this.mouseTracked.add(id);
    else this.mouseTracked.delete(id);
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
    };
  }

  op_ts([, id, states]) {
    const el = this.view(id);
    if (!el) return;
    el._tracked = states;
    el._states = 0;
    if (states & HOVERED && !el._hoverListeners) {
      el._hoverListeners = true;
      el.addEventListener("pointerenter", (e) => e.pointerType === "mouse" && this.setState(el, HOVERED, true));
      el.addEventListener("pointerleave", () => this.setState(el, HOVERED, false));
    }
  }

  setState(el, bit, on) {
    if (!el._tracked || !(el._tracked & bit)) return;
    const next = on ? el._states | bit : el._states & ~bit;
    if (next === el._states) return;
    el._states = next;
    this.call((w) => w.nsh_states(el._id, next));
  }

  op_vp([, id, props]) {
    const el = this.view(id);
    if (!el) return;
    el._props = props;
    if (props.testID) el.dataset.testid = props.testID;
    else delete el.dataset.testid;
    const pe = props.pointerEvents;
    el.classList.toggle("nsh-inert", pe === "none");
    el.classList.toggle("nsh-box-none", pe === "box-none");
    el.classList.toggle("nsh-area", !!props.selectableView);
    this.updateFocusable(el);
    this.updateTouchAction(el);
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
    const set = (name, value) => (value == null || value === false ? el.removeAttribute(name) : el.setAttribute(name, String(value)));
    const role = ARIA_ROLES[p.role] ?? (p.role && p.role !== "none" ? p.role : el._pressable ? "button" : null);
    set("role", role);
    set("aria-label", p.label ?? el._textLabel);
    set("aria-description", p.hint);
    set("aria-disabled", p.disabled && "true");
    set("aria-selected", p.selected && "true");
    set("aria-checked", p.checked);
    set("aria-busy", p.busy && "true");
    set("aria-expanded", p.expanded);
    const [min, max, now, text] = p.value ?? [];
    set("aria-valuemin", min);
    set("aria-valuemax", max);
    set("aria-valuenow", now);
    set("aria-valuetext", text);
    set("aria-live", p.live);
    set("aria-hidden", p.hidden && "true");
  }

  /** The stops of the keyboard focus (Tab), as `ViewProps::focus_stop`
   * decides: pressables (Enter and Space press them) unless `focusable`
   * false, and any `focusable` view, pressable or not (its keys reach it
   * through the app's keymap); never disabled ones or those hidden from
   * assistive technologies. */
  updateFocusable(el) {
    const p = el._props;
    const focusable = (p?.focusable ?? !!el._pressable) && !p?.disabled && !p?.hidden;
    if (focusable) el.tabIndex = 0;
    // Programmatic focus only for what screen-reader focus moved to.
    else if (el._a11yFocus) el.tabIndex = -1;
    else if (el.hasAttribute("tabindex")) el.removeAttribute("tabindex");
    // No longer a stop with the focus on it: it leaves, as on macOS (browsers
    // move it without a `blur`, which would leave `focus:` on).
    if (!focusable && !el._a11yFocus && document.activeElement === el) el.blur();
    if (focusable && !el._focusListeners) {
      el._focusListeners = true;
      // `focus:` classes and `onFocus` follow the keyboard focus (the
      // browser draws a ring only then), not the focus a click would give.
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
    this.updateAria(el);
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
      el.focus({ focusVisible: true });
    } finally {
      el._focusCall = false;
    }
  }

  /** What touches on `el` leave to the browser: nothing on views with
   * native pans, pinches or rotations; a `panActivation` gate along one
   * axis leaves scrolling along the other. Views that take presses or
   * touches are marked: text in them is not selected by default. */
  updateTouchAction(el) {
    const pan = el._gestures?.pan || el._events.has("onPanStart") || el._events.has("onPanEnd");
    const pinch = el._gestures?.pinch || el._gestures?.rotation;
    el.classList.toggle("nsh-press", !!(el._pressable || pan || pinch || el._events.has("onTouch")));
    const gate = el._props?.panActivation;
    const horizontal = gate && gate[0] != null && gate[1] == null;
    const vertical = gate && gate[1] != null && gate[0] == null;
    el.classList.toggle("nsh-pan", !!(pinch || (pan && !horizontal && !vertical)));
    el.classList.toggle("nsh-pan-x", !pinch && !!horizontal);
    el.classList.toggle("nsh-pan-y", !pinch && !!vertical);
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
  op_img([, id, uri, mode, placeholder, blur, fade, position]) {
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
        if (el._ph.getAttribute("src") !== ph) el._ph.src = ph;
      } else {
        el._ph.remove();
        el._ph = null;
      }
    }
    const src = this.asset(uri ?? "");
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
    img.src = src;
    // Only an image that had to load fades in (the native backends').
    if (img.complete) img.style.opacity = "";
    this.applyTint(el);
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
  // size, and the picture moves to the view's own canvas, under its
  // children and inside its rounded corners. A view renders when what it
  // reads changed (size, uniforms, animated slots) or, reading the time,
  // on every animation frame while it is in sight and not paused.

  op_sh([, id, layer]) {
    const el = this.view(id);
    if (!el) return;
    if (!layer) {
      el._shaderCanvas?.remove();
      el._shaderCanvas = null;
      el._shaderObserver?.disconnect();
      el._shader = null;
      this.shaderViews.delete(el);
      return;
    }
    const old = el._shader;
    const words = new Uint32Array(layer.words);
    // Animated slots keep their values while the program and slots stay.
    if (old && old.layer.key === layer.key && JSON.stringify(old.layer.slots) === JSON.stringify(layer.slots)) {
      for (const [word, kind] of layer.slots) {
        const n = kind === 3 ? 3 : kind === 4 ? 4 : 1;
        for (let i = 0; i < n; i++) words[word + i] = old.words[word + i];
      }
    }
    const now = performance.now();
    const kept = old ? old.kept + (old.since != null ? now - old.since : 0) : 0;
    el._shader = { layer, words, kept, since: layer.paused ? null : now, dirty: true };
    if (!el._shaderCanvas) {
      const canvas = document.createElement("canvas");
      canvas.className = "nsh-fill nsh-shader";
      el.insertBefore(canvas, el.firstChild);
      el._shaderCanvas = canvas;
      el._shaderVisible = true;
      if (typeof IntersectionObserver !== "undefined") {
        el._shaderObserver = new IntersectionObserver((entries) => {
          el._shaderVisible = entries[entries.length - 1].isIntersecting;
          if (el._shaderVisible) this.shaderDirty(el);
        });
        el._shaderObserver.observe(el);
      }
    }
    this.shaderViews.add(el);
    this.shaderDirty(el);
  }

  /** Writes an animated value into its slot (`op_a`'s `canvas:N`): a number, or a CSS color. */
  shaderSlot(el, slot, value) {
    const s = el._shader;
    const entry = s.layer.slots[slot];
    if (!entry) return;
    const [word, kind] = entry;
    const f32 = new Float32Array(s.words.buffer);
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
    let again = false;
    for (const el of this.shaderViews) {
      const s = el._shader;
      if (!el.isConnected || !s) continue;
      const runs = s.layer.animated && s.since != null;
      if (!el._shaderVisible || !(s.dirty || runs)) continue;
      s.dirty = false;
      this.renderShader(el, t);
      again ||= runs;
    }
    if (again) {
      this.shaderFrameQueued = true;
      requestAnimationFrame((t) => this.shaderFrame(t));
    }
  }

  /** The shared WebGL 2 context; `null` where there is none (said once). */
  shaderGl() {
    if (this._shaderGl !== undefined) return this._shaderGl;
    const canvas = typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(1, 1) : document.createElement("canvas");
    const gl = canvas.getContext("webgl2", { premultipliedAlpha: true, antialias: false, preserveDrawingBuffer: false });
    if (!gl) console.warn("[nsh] shaders: no WebGL 2; shader views draw nothing");
    this._shaderGl = gl;
    this._shaderPrograms = new Map();
    return gl;
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
      entry = { program, builtins: block(layer.nsh, 0), uniforms: block(layer.u, 1), vao: gl.createVertexArray() };
    }
    this._shaderPrograms.set(layer.key, entry);
    return entry;
  }

  renderShader(el, t) {
    const s = el._shader;
    const gl = this.shaderGl();
    if (!gl || !el._frame) return;
    const program = this.shaderProgram(gl, s.layer);
    if (!program) return;
    const [, , w, h] = el._frame;
    let ratio = (devicePixelRatio || 1) * Math.min(4, this.zoomOf(el));
    ratio = Math.min(ratio, 4096 / Math.max(w, h, 1));
    const pw = Math.max(1, Math.round(w * ratio));
    const ph = Math.max(1, Math.round(h * ratio));
    const canvas = gl.canvas;
    if (canvas.width !== pw || canvas.height !== ph) {
      canvas.width = pw;
      canvas.height = ph;
    }
    const time = (s.kept + (s.since != null ? t - s.since : 0)) / 1000;
    gl.viewport(0, 0, pw, ph);
    gl.useProgram(program.program);
    gl.bindVertexArray(program.vao);
    if (program.builtins) {
      gl.bindBuffer(gl.UNIFORM_BUFFER, program.builtins);
      gl.bufferData(gl.UNIFORM_BUFFER, new Float32Array([w, h, Math.max(0, time), pw / Math.max(w, 1e-6)]), gl.DYNAMIC_DRAW);
      gl.bindBufferBase(gl.UNIFORM_BUFFER, 0, program.builtins);
    }
    if (program.uniforms) {
      gl.bindBuffer(gl.UNIFORM_BUFFER, program.uniforms);
      gl.bufferData(gl.UNIFORM_BUFFER, s.words, gl.DYNAMIC_DRAW);
      gl.bindBufferBase(gl.UNIFORM_BUFFER, 1, program.uniforms);
    }
    gl.disable(gl.BLEND);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    const target = el._shaderCanvas;
    if (target.width !== pw || target.height !== ph) {
      target.width = pw;
      target.height = ph;
    }
    if (canvas.transferToImageBitmap) {
      target._bitmap ??= target.getContext("bitmaprenderer");
      target._bitmap.transferFromImageBitmap(canvas.transferToImageBitmap());
    } else {
      target._2d ??= target.getContext("2d");
      target._2d.clearRect(0, 0, pw, ph);
      target._2d.drawImage(canvas, 0, 0);
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
    this.placeLayer(el);
    this.snapMarkers(el);
    // The last sticky cell travels to the end of the content.
    for (const cell of el._tracks?.values() ?? []) this.placeTrack(cell);
  }

  op_sb([, id, dx, dy]) {
    const el = this.view(id);
    if (!el) return;
    el._applied++;
    // A smooth scroll of the core's in flight moves with it, as on the
    // native backends: setting the offset would stop it.
    if (el._smooth) {
      el._smooth = [el._smooth[0] + dx, el._smooth[1] + dy];
      el.scrollTo({ left: el._smooth[0], top: el._smooth[1], behavior: "smooth" });
      return;
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
    el._behavior = behavior;
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
   * indicator, and horizontal ones always (a mouse without a horizontal
   * wheel has no other way to move them, as mouse drags do not scroll),
   * unless a built-in bar of the app's takes their place. */
  barShown(el) {
    return this.desktopUI && el._kind === "scroll" && !this.zooms(el) && el._behavior?.enabled !== false && !!(el._indicator || (el._horizontal && !el._replaced));
  }

  /** `el`'s thumb along its axis: `[start, length, travel, max offset]`, or null when the content fits. */
  barThumb(el) {
    const h = !!el._horizontal;
    const view = h ? el.clientWidth : el.clientHeight;
    const total = h ? el.scrollWidth : el.scrollHeight;
    if (total <= view + 0.5 || view <= 4 * BAR_MARGIN) return null;
    const track = view - 2 * BAR_MARGIN;
    const len = Math.min(track, Math.max(32, (track * view) / total));
    const max = total - view;
    const t = Math.min(Math.max((h ? el.scrollLeft : el.scrollTop) / max, 0), 1);
    return [BAR_MARGIN + t * (track - len), len, track - len, max];
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
    const edge = (el._horizontal ? el.clientHeight : el.clientWidth) - BAR_THICK - BAR_MARGIN;
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
    const [along, across, edge] = el._horizontal ? [x, y, el.clientHeight] : [y, x, el.clientWidth];
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
    clearTimeout(el._commandEnd);
    el._commandEnd = 0;
    el._smooth = null;
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
    el._cancelPull = () => {
      start = null;
      el._pulling = false;
    };
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
    cx.save();
    const slots = el._slots;
    const v = (n) => (Array.isArray(n) && n[0] === "$" ? (slots[n[1]] ?? 0) : n);
    const paint = (p) => {
      if (Array.isArray(p) && p[0] === "$") return slots[p[1]] ?? "transparent";
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
    for (const [name, ...args] of el._ops) {
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
          const img = this.canvasImage(args[0], el);
          if (!img) continue;
          const dest = args.slice(2).map(v);
          if (args[1]) cx.drawImage(img, ...args[1], ...dest);
          else cx.drawImage(img, ...dest);
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
      img.src = src;
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
    }
    swapClass(field, "_class", this.styleClass(css));
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
    field.autocapitalize = config.autoCapitalize === "none" ? "off" : config.autoCapitalize;
    field.spellcheck = config.autoCorrect;
    if (config.maxLength != null) field.maxLength = config.maxLength;
    else field.removeAttribute("maxlength");
    el._config = config;
    field.classList.toggle("nsh-ph", !!config.placeholderColor);
    // A built-in bar of the app's takes the textarea's indicator's place.
    field.classList.toggle("nsh-noindicator", !!config.noIndicator);
    this.inputScrolled(el, field);
    if (config.autoFocus && !el._autoFocused) {
      el._autoFocused = true;
      el._autoFocusTimer = setTimeout(() => {
        el._autoFocusTimer = null;
        if (el.isConnected) field.focus();
      }, 0);
    }
  }

  wireInput(el, field) {
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
      // RichEditor would delete twice on Backspace.
      if (el._events.has("onKeyPress") && this.shortcut(e, true) === -1) {
        const key = e.key === "Backspace" || e.key === "Enter" || e.key === "Escape" ? e.key : e.key.length === 1 ? e.key : null;
        if (key) this.event(el._id, "onKeyPress", { key });
      }
      // Return submits unless it inserts a line break (`submitBehavior`);
      // Shift / Alt+Return always do in a textarea, and a return that
      // commits an input method's composition never submits.
      const submit = el._config?.submit ?? "blurAndSubmit";
      const lineBreak = field.tagName === "TEXTAREA" && (submit === "newline" || e.shiftKey || e.altKey);
      if (e.key === "Enter" && !lineBreak && !e.isComposing && e.keyCode !== 229) {
        e.preventDefault();
        this.event(el._id, "onSubmitEditing", { text: field.value, count: field._count });
        if (submit === "blurAndSubmit") field.blur();
      }
    });
    field.addEventListener("focus", () => {
      this.setState(el, FOCUSED, true);
      this.event(el._id, "onFocus");
    });
    field.addEventListener("blur", () => {
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
   * its viewport's, while a built-in bar takes its indicator's place. */
  inputScrolled(el, field) {
    if (!el._config?.replaced || field.tagName !== "TEXTAREA") return;
    const now = [field.scrollTop, field.clientWidth, field.scrollHeight, field.clientHeight];
    if (field._scrolled?.every((v, i) => v === now[i])) return;
    field._scrolled = now;
    this.call((w) => w.nsh_input_scroll(el._id, ...now));
  }

  textChanged(el, field) {
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
    if (field.value !== text) field.value = text;
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
    if (header?._listRetired) return;
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
    // The screen goes, then the app is told (and removes it).
    const dismissed = () => this.event(screen._id, "onDismiss");
    if (this.screenMotion(screen)) {
      this.moveScreens(screen, below, false, dismissed);
    } else {
      screen.style.visibility = "hidden";
      dismissed();
    }
    this.syncHistorySoon();
  }

  /** A stack's screens, without one going back. */
  screensOf(stack) {
    return [...stack.children].filter((s) => s._kind === "screen" && !s._popping && !s._removedFrom);
  }

  /** A parked screen changes the native stack without navigation or focus return. */
  resetStack(stack) {
    clearTimeout(stack._hideTimer);
    const screens = this.screensOf(stack);
    stack._shown = screens;
    stack._top = screens[screens.length - 1] ?? null;
    for (const screen of screens) {
      const top = screen === stack._top;
      screen.classList.toggle("nsh-hidden", !top);
      if (top) screen.style.transform = "";
      this.placeHeader(screen);
    }
    this.syncHistorySoon();
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
    const motion = this.screenMotion(pushing ? top : old);
    if (!motion) {
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
    if (done) a.onfinish = done;
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

  /** The innermost shown stack (inside `within`, else anywhere) that goes
   * back: it has a screen under the top one, or a top one that asks. */
  backStack(within) {
    const shown = (el) => el.isConnected && (el.checkVisibility?.({ visibilityProperty: true }) ?? true);
    const candidates = [];
    for (const el of this.views.values()) {
      if (el._kind !== "stack" || !shown(el) || (within && !within.contains(el))) continue;
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
  // (`history.go`), their `popstate` ignored.

  installHistory() {
    this.historyDepth = 0;
    this.ignoredPops = 0;
    // Entries are this page load's: those of an earlier load (a reload
    // keeps them, with their depths) are foreign, below this one's.
    this.historySession = `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
    history.replaceState(this.historyState(0), "");
    window.addEventListener("popstate", (e) => this.popState(e));
  }

  historyState(depth) {
    return { ...(history.state ?? {}), nsh: depth, nshSession: this.historySession };
  }

  /** A new run starts at the app's first entry. */
  resetHistory() {
    if (!this.history || !this.historyDepth) return;
    this.ignoredPops++;
    history.go(-this.historyDepth);
    this.historyDepth = 0;
  }

  backDepth() {
    let depth = [...this.root.children].filter((el) => el._kind === "modal" && !el._leaving).length;
    for (const el of this.views.values()) {
      if (el._kind === "stack" && el.isConnected && (el.checkVisibility?.({ visibilityProperty: true }) ?? true)) {
        depth += Math.max(0, this.screensOf(el).length - 1);
      }
    }
    return depth;
  }

  syncHistorySoon() {
    if (!this.history || this.historySync) return;
    this.historySync = setTimeout(() => {
      this.historySync = 0;
      this.syncHistory();
    }, 0);
  }

  syncHistory() {
    const depth = this.backDepth();
    const have = this.historyDepth;
    for (let i = have + 1; i <= depth; i++) history.pushState(this.historyState(i), "");
    if (depth < have) {
      this.ignoredPops++;
      history.go(depth - have);
    }
    this.historyDepth = depth;
  }

  popState(e) {
    if (this.ignoredPops > 0) {
      this.ignoredPops--;
      return;
    }
    const have = this.historyDepth;
    if (e.state?.nshSession !== this.historySession) {
      // Back past the app's first entry: the app goes back to its start.
      // An earlier load's entries (a reload keeps them) are passed over,
      // as if the page had been left from its first screen.
      this.historyDepth = 0;
      for (let i = 0; i < have; i++) if (!this.back()) break;
      if (e.state?.nsh != null) history.back();
      return;
    }
    const at = e.state.nsh ?? 0;
    if (at < have) {
      // Back (several entries from the back button's menu): what the app
      // does not let go back gets its entry again.
      this.historyDepth = at;
      for (let i = at; i < have; i++) if (!this.back()) break;
      this.syncHistorySoon();
    } else if (at > have) {
      // Forward to a screen that is gone: back where the app is.
      this.ignoredPops++;
      history.go(have - at);
    }
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
    const box = viewport ? { left: 0, top: 0, right: w, bottom: h } : undefined;
    const insets = this.safeProbe ? this.safeArea(box) : [0, 0, 0, 0];
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
    // Retire must cancel pending callbacks before the core rebinds this node.
    cancelAnimationFrame(el._modalEnterFrame);
    clearTimeout(el._modalShowTimer);
    clearTimeout(el._modalDismissTimer);
    el._modalOrder = this.modalOrder = (this.modalOrder ?? 0) + 1;
    const motion = this.modalMotion(el);
    el._leaving = false;
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
    el._entering = true;
    this.scopeFocus();
    this.syncHistorySoon();
    el._modalEnterFrame = requestAnimationFrame(() => {
      el._modalEnterFrame = requestAnimationFrame(() => {
        el._modalEnterFrame = 0;
        if (!el.isConnected || el._leaving || el._listRetired) return;
        el._entering = false;
        el.style.transition = "";
        el.style.transform = "";
        el.style.opacity = "";
        el._modalShowTimer = setTimeout(() => {
          el._modalShowTimer = 0;
          if (el.isConnected && !el._leaving && !el._listRetired) this.event(el._id, "onShow");
        }, motion === "none" ? 0 : 350);
      });
    });
  }

  /** Takes modal `el` away; `onDismiss` follows unless `reported`. */
  dismiss(el, reported = el._closed) {
    if (el._leaving) return;
    cancelAnimationFrame(el._modalEnterFrame);
    clearTimeout(el._modalShowTimer);
    el._leaving = true;
    const motion = this.modalMotion(el);
    this.hideModal(el, motion);
    this.scopeFocus();
    this.syncHistorySoon();
    const restore = el._restoreFocus;
    if (restore?.isConnected && !this.topModal()) restore.focus({ preventScroll: true });
    el._modalDismissTimer = setTimeout(() => {
      el._modalDismissTimer = 0;
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
      if (this.frameSession === session) this.frameSession = null;
    };
    window.addEventListener("pagehide", close, { once: true });
    const ready = (lease) => {
      if (cancelled) { lease.release(); return; }
      release = lease.release; pin(lease.rect);
      for (const layer of layers) if (layer._kind === "modal") this.placeModal(layer);
    };
    try {
      if (window.frameElement) {
        ready(frameViewport(window.frameElement));
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
      window.parent.postMessage("nsh:viewport", "*", [channel.port2]);
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
      if (el._token) head += `<script>${webBridge(el._token)}</script>`;
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
      if (url) frame.src = url;
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
    if (paused) video.pause();
    else if (url && video.paused) {
      video.play().catch((err) => {
        // Browsers only start sound on their own after a user gesture.
        if (err?.name === "NotAllowedError" && !el._autoplayWarned) {
          el._autoplayWarned = true;
          console.warn("[nsh] the browser did not let the video play before a user gesture (muted videos can)");
        }
      });
    }
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
        if (el?._field) el._field.focus();
        else if (el) this.focusPressable(el);
        break;
      case "blur":
        if (el?._field) el._field.blur();
        else document.activeElement?.blur?.();
        break;
      case "setSelection": el?._field?.setSelectionRange(args[0], args[1]); break;
      case "scrollTo":
        if (!el) break;
        // A textarea's text (a built-in bar's drags).
        if (el._field) {
          el._field.scrollTo({ top: args[1], behavior: args[2] ? "smooth" : "instant" });
          break;
        }
        el._applied++;
        this.stopGlide(el, args[0], args[1]);
        el._smooth = args[2] ? [args[0], args[1]] : null;
        el.scrollTo({ left: args[0], top: args[1], behavior: args[2] ? "smooth" : "instant" });
        break;
      case "scrollToEnd": {
        if (!el) break;
        el._applied++;
        const [x, y] = el._horizontal ? [el.scrollWidth, 0] : [0, el.scrollHeight];
        this.stopGlide(el, x, y);
        el.scrollTo({ left: x, top: y, behavior: args[0] ? "smooth" : "instant" });
        break;
      }
      case "zoomTo": if (el) this.zoomCommand(el, ...args); break;
      case "dialog": this.dialog(args[0], args[1], args[2], args[3], args[4] ?? [], args[5] ?? true, args[6] ?? false); break;
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
      case "seek": if (el?._video) el._video.currentTime = args[0]; break;
      case "openUrl": this.event(ROOT_ID, "onOpenUrl", { id: args[0], opened: this.openUrl(args[1]) }); break;
      case "setClipboard": this.writeClipboard(args[0]); break;
      case "readClipboard": this.readClipboard(args[0], args[1]); break;
      case "setClipboardImage": this.writeClipboardImage(args[0]); break;
      case "readClipboardImage": this.readClipboardImage(args[0], args[1]); break;
      // Pages see no local paths: never any files.
      case "readClipboardFiles": this.event(ROOT_ID, "onClipboard", { id: args[0], has: false, files: "" }); break;
      case "pickImages": this.pickImages(args[0], args[1], args[2], args[3], args[4]); break;
      case "hostCall": this.hostCall(args[0], args[1], args[2]); break;
      case "imageInfo": this.imageInfo(args[0], args[1]); break;
      case "back": this.defaultBack(); break;
      case "exitApp": {
        const app = this.app;
        // Finish the current engine call before releasing its surface.
        queueMicrotask(() => { if (this.app === app) this.reset(); });
        break;
      }
      case "announce":
        // Cleared first: the same text again is announced again.
        this.live.textContent = "";
        setTimeout(() => { this.live.textContent = args[0]; }, 50);
        break;
      case "a11yFocus":
        if (!el) break;
        if (!el.hasAttribute("tabindex")) {
          el.tabIndex = -1;
          el._a11yFocus = true;
        }
        el.focus();
        break;
      default: break;
    }
  }



  /**
   * `Clipboard.writeText`. The async Clipboard API needs a secure context
   * (and, in some browsers, a user gesture); a copy command is the fallback.
   */
  writeClipboard(text) {
    const copy = () => {
      const area = document.createElement("textarea");
      area.value = text;
      area.className = "nsh-offscreen";
      document.body.append(area);
      area.select();
      try {
        document.execCommand("copy");
      } catch {
        // Nothing left to try.
      }
      area.remove();
    };
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).catch(copy);
    else copy();
  }

  /**
   * `Clipboard.readText` / `hasText`: browsers only tell by reading,
   * which may ask the user (Chromium asks once per site; Safari and Firefox
   * show a paste button), and fails in an insecure context. `hasText`
   * reads too: there is no way to ask without reading.
   */
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

  /** `Clipboard.writeImage`: a `data:` URI's image as a clipboard item (browsers take PNG). */
  async writeClipboardImage(uri) {
    try {
      const blob = await (await fetch(uri)).blob();
      await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
    } catch {
      // Denied, an insecure context, or a type the browser does not write.
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
        const type = item.types.find((t) => t.startsWith("image/"));
        if (type) {
          blob = await item.getType(type);
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
    img.src = this.asset(uri);
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
      if (!navigator.storage?.getDirectory) throw error("ENOTSUP", "This browser does not provide Origin Private File System storage");
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
    socket.onopen = () => report(0, socket.protocol);
    socket.onmessage = (event) => report(typeof event.data === "string" ? 1 : 2,
      typeof event.data === "string" ? event.data : new Uint8Array(event.data));
    socket.onerror = () => report(3, "Browser WebSocket failed (network, TLS, origin or server handshake error)");
    socket.onclose = (event) => report(4, event.reason, event.code, event.wasClean);
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
  fetchStart(id, method, url, headers, body, streamed, follow) {
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
      const init = { method, headers: new Headers(), body, redirect: follow ? "follow" : "manual", signal: request.controller.signal };
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
   * presses the cancel button if any (`keyDown`, `_cancel`).
   */
  dialog(dialogId, title, message, buttons, styles, cancelable, sheet) {
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
    const close = (index) => {
      if (answered) return;
      answered = true;
      backdrop.remove();
      this.releaseFrame(backdrop);
      this.dialogs = this.dialogs.filter((d) => d !== backdrop);
      this.scopeFocus();
      if (restore?.isConnected) restore.focus({ preventScroll: true });
      this.event(ROOT_ID, "onDialog", { id: dialogId, index });
    };
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
    }
    backdrop.addEventListener("click", (e) => e.target === backdrop && down === backdrop && cancelable && close(-1));
    backdrop.append(box);
    this.root.append(backdrop);
    if (this.viewportDialogs) this.raise(backdrop);
    (this.dialogs ??= []).push(backdrop);
    this.scopeFocus();
    focus?.focus({ preventScroll: true });
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

  focusPath(target = document.activeElement) {
    return target && this.root.contains(target) ? this.ancestors(this.viewOf(target)).map((view) => view._id) : [];
  }

  /** Convert viewport coordinates through the view's composed 2D transforms. */
  mousePoint(el, e) {
    let a = 1, b = 0, c = 0, d = 1;
    for (let node = el; node; node = node.parentElement) {
      const transform = getComputedStyle(node).transform;
      if (transform !== "none") {
        const m = new DOMMatrix(transform);
        [a, b, c, d] = [m.a * a + m.c * b, m.b * a + m.d * b,
          m.a * c + m.c * d, m.b * c + m.d * d];
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

  installInput() {
    const root = this.root;
    root.addEventListener("pointerdown", (e) => this.pointerDown(e));
    window.addEventListener("pointermove", (e) => this.pointerMove(e), { passive: false });
    window.addEventListener("pointerup", (e) => this.pointerUp(e, false));
    window.addEventListener("pointercancel", (e) => this.pointerUp(e, true));
    // A drag never drags images or text out of the app.
    root.addEventListener("dragstart", (e) => e.preventDefault());
    // A click leaves the keyboard focus where it is (in a field, too) and
    // selects nothing, as in native apps; fields, selectable text and
    // hosted pages and videos take it as usual.
    root.addEventListener("mousedown", (e) => {
      if (this.lastPointer === "touch" || this.editable(e.target)) return;
      e.preventDefault();
      // Which would also keep the keys from an app in an iframe.
      if (!document.hasFocus()) window.focus();
    });
    // No page menu over the app (nor iOS's callout on a long press); fields
    // and selectable text keep theirs.
    root.addEventListener("contextmenu", (e) => this.contextMenu(e) || this.editable(e.target) || e.preventDefault());
    root.addEventListener("copy", (e) => this.copyText(e));
    root.addEventListener("wheel", (e) => this.wheel(e), { passive: false });
    // Safari's touchpad pinches (it sends no ctrl+wheel).
    root.addEventListener("gesturestart", (e) => this.gestureZoom(e, 0));
    root.addEventListener("gesturechange", (e) => this.gesture && this.gestureZoom(e, 1));
    root.addEventListener("gestureend", (e) => this.gesture && this.gestureZoom(e, 2));
    root.addEventListener("pointermove", (e) => {
      this.mouseMoved(e);
      if (e.pointerType !== "mouse") return;
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
   * right clicks, Control-clicks on macOS and the keyboard's menu key.
   */
  contextMenu(e) {
    const view = this.viewOf(e.target);
    if (!view) return false;
    for (const el of this.ancestors(view)) {
      if (el._events?.has("onContextMenu")) {
        e.preventDefault();
        const [pageX, pageY] = this.point(e);
        const r = el.getBoundingClientRect();
        this.event(el._id, "onContextMenu", {
          position: { x: e.clientX - r.left, y: e.clientY - r.top },
          pagePosition: { x: pageX, y: pageY },
          modifiers: { control: e.ctrlKey, alt: e.altKey, shift: e.shiftKey, platform: e.metaKey },
        });
        return true;
      }
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
    if (!MODIFIER_KEYS.has(e.key) || e.repeat || !this.hover || this.hoverButtons || !this.mouseTracked.size) return;
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

  /**
   * The app's shortcut (`nsh/keymap`) key `e` fires, matched natively
   * against the mounted table: its binding, -2 for a held key whose binding
   * does not repeat, -1 for none.
   */
  shortcut(e, editing) {
    const code = e.isComposing ? -1 : keyCode(e);
    if (code < 0) return -1;
    const mods = (e.ctrlKey ? 1 : 0) | (e.altKey ? 2 : 0) | (e.shiftKey ? 4 : 0) | (e.metaKey ? 8 : 0);
    return this.wasm.nsh_key(code, mods, editing ? 1 : 0, e.repeat ? 1 : 0);
  }

  keyDown(e) {
    if (this.wasm) this.modifiersChanged(e);
    if (!this.wasm || !this.takesKeys()) return;
    const focus = document.activeElement;
    const inRoot = focus && this.root.contains(focus);
    const editing = inRoot && !!focus.closest(".nsh-field, iframe");
    // The app's shortcuts first, where the focus is (`nsh/keymap`), then
    // reported.
    const found = this.shortcut(e, editing);
    if (found !== -1) {
      e.preventDefault();
      e.stopPropagation();
      if (found >= 0) this.call((w) => w.nsh_key_command(found));
      return;
    }
    if (e.defaultPrevented || e.isComposing) return;
    const plain = !e.ctrlKey && !e.altKey && !e.metaKey;
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
    if (this.selectionKey(e)) return;
    if (inRoot && focus._pressable && plain && !e.shiftKey && (e.key === "Enter" || e.key === " ")) {
      e.preventDefault();
      if (e.repeat) return;
      // Return presses at once, Space when it is released, as buttons do.
      this.keyPress = { press: focus, states: this.ancestors(focus).filter((v) => v._tracked & PRESSED) };
      this.pressIn(this.keyPress);
      for (const v of this.keyPress.states) this.setState(v, PRESSED, true);
      if (e.key === "Enter") this.keyPressEnd(true);
      return;
    }
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
   * table's cells) are joined by a tab instead, and attachments (U+FFFC)
   * are left out, as the native platforms copy. */
  copyText(e) {
    const sel = getSelection();
    if (e.target.closest?.(".nsh-field")) return;
    if (!sel?.rangeCount || sel.isCollapsed || !this.root.contains(sel.anchorNode)) return;
    const range = sel.getRangeAt(0);
    let out = "";
    let last = null;
    let lastArea = null;
    let lastBox = null;
    let found = false;
    for (const run of this.root.querySelectorAll(".nsh-run")) {
      // Text that cannot be selected is not copied, as by the browser.
      if (!range.intersectsNode(run) || !this.selectableText(run)) continue;
      // A link's characters are in a span inside the run.
      const text = run.textContent;
      if (!text) continue;
      const from = run.contains(range.startContainer) ? runOffset(run, range.startContainer, range.startOffset) : 0;
      const to = run.contains(range.endContainer) ? runOffset(run, range.endContainer, range.endOffset) : text.length;
      if (from >= to) continue;
      found = true;
      const area = this.areaOf(run.parentNode);
      if (last !== run.parentNode) {
        const box = area ? run.parentNode.getBoundingClientRect() : null;
        if (last && area && area === lastArea && box.top < lastBox.bottom && lastBox.top < box.bottom) {
          out = out.replace(/\n$/, "") + "\t";
        } else if (last && !out.endsWith("\n")) out += "\n";
        last = run.parentNode;
        lastArea = area;
        lastBox = box;
      }
      const part = text.slice(from, to);
      out += area ? part.replaceAll("\uFFFC", "") : part;
      if (to === text.length && run._after) out += run._after;
    }
    if (!found) return;
    e.preventDefault();
    e.clipboardData.setData("text/plain", out.replace(/\s+$/, ""));
  }

  /** Select all and Escape in selectable text with a selection: within it. */
  selectionKey(e) {
    const sel = getSelection();
    const anchor = sel?.anchorNode;
    const text = sel?.rangeCount && !sel.isCollapsed && anchor && this.root.contains(anchor)
      ? this.selectableText(anchor.nodeType === 1 ? anchor : anchor.parentElement)
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
    const d = { ArrowUp: -40, ArrowLeft: -40, ArrowDown: 40, ArrowRight: 40, PageUp: -page, PageDown: page,
      " ": e.shiftKey ? -page : page, Home: -pos, End: max - pos }[k];
    if (el._snapPoints) this.snapStep(el, Math.sign(d));
    else this.scrollSmoothly(el, h ? d : 0, h ? 0 : d, true);
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
   * (events 200 ms apart). Notches glide; Ctrl + wheel (a touchpad's pinch)
   * pinches the view under the pointer and never zooms the page.
   */
  wheel(e) {
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
      // Nothing to scroll: the page around may, unless a dialog or an
      // alert covers it.
      this.wheelLock = lock = el ? { el, total: 0, snapped: false } : null;
      if (!lock) {
        if (this.viewportDialogs && e.target.closest?.(".nsh-viewport")) e.preventDefault();
        return;
      }
    }
    e.preventDefault();
    lock.t = now;
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
    const smooth = e.deltaMode !== 0 || Math.abs(d) >= 40;
    this.scrollSmoothly(el, el._horizontal ? d : 0, el._horizontal ? 0 : d, smooth);
  }

  /** Moves `el` by (`dx`, `dy`), gliding there when `smooth`; once it
   * settles (no more input for 200 ms), `onScrollEnd`. */
  scrollSmoothly(el, dx, dy, smooth) {
    let a = el._glide;
    if (!a) {
      a = el._glide = { x: el.scrollLeft, y: el.scrollTop, frame: 0, timer: 0, last: 0 };
      this.drive(el, 1);
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
    clearTimeout(a.timer);
    a.timer = setTimeout(() => {
      a.timer = 0;
      settle();
    }, 200);
  }

  /** Stops `el`'s glide where it is for a scroll command of the core's to
   * (`x`, `y`), as the native backends interrupt theirs: left running, its
   * next frame would put the offset back. The browser's `scrollend` after
   * the command's scroll ends the scroll it stopped; a command that leaves
   * the view where it is moves nothing, and no `scrollend` follows, so its
   * `onScrollEnd` is sent here. */
  stopGlide(el, x, y) {
    const a = el._glide;
    if (!a) return;
    cancelAnimationFrame(a.frame);
    clearTimeout(a.timer);
    el._glide = null;
    this.drive(el, -1);
    // Browsers clamp the offsets of scrolls.
    const stays = (to, at, max) => Math.min(Math.max(to, 0), max) === at;
    if (stays(x, el.scrollLeft, el.scrollWidth - el.clientWidth) && stays(y, el.scrollTop, el.scrollHeight - el.clientHeight)) {
      this.ownEnd(el);
    } else {
      // A fractional destination may round back to the current offset,
      // in which case the browser sends no scrollend. Moving commands
      // keep this fallback waiting through their scroll events.
      this.waitCommandEnd(el);
    }
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
    return [e.clientX - left, e.clientY - top];
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
      const rect = this.view(target)?.getBoundingClientRect();
      const [left, top] = this.origin(p.layer);
      points.push({
        id, target, path: p.touchPath,
        pageX: p.x, pageY: p.y,
        x: rect ? p.x + left - rect.left : p.x,
        y: rect ? p.y + top - rect.top : p.y,
        changed: id === changedId,
      });
    }
    if (!points.length) return;
    const json = JSON.stringify({ phase, time: performance.now(), points, activated });
    this.call(() => this.withStrings([json], (p, l) => this.wasm.nsh_touch(p, l)));
  }

  pointerDown(e) {
    this.lastPointer = e.pointerType;
    // A press without a move still holds a button: a modifier key then
    // fires no hover move (`modifiersChanged`).
    if (e.pointerType === "mouse") this.hoverButtons = e.buttons;
    Player.active = this;
    if (e.button > 0) return;
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
    const p = {
      target,
      x, y, layer, startX: x, startY: y, t: performance.now(), vx: 0, vy: 0,
      touchPath: chain.filter((v) => v._events.has("onTouch")).map((v) => v._id),
      press: isField ? null : this.linkPress(e.target, target) ?? chain.find((v) => PRESS_EVENTS.some((n) => v._events.has(n)) && !v._props?.disabled) ?? null,
      // What presses report: the modifier keys at the press and its clicks.
      modifiers: { control: e.ctrlKey, alt: e.altKey, shift: e.shiftKey, platform: e.metaKey },
      clicks: e.pointerType === "mouse" ? this.clickCount(x, y) : 1,
      pan: chain.find((v) => v._gestures?.pan || v._events.has("onPanStart") || v._events.has("onPanEnd")) ?? null,
      scroll: !selects && scrollView && e.pointerType !== "mouse" && this.zooms(scrollView) ? scrollView : null,
      // Touch scrolling is the browser's, reported from here (`touchScroll`).
      scrolls: e.pointerType === "touch" ? chain.filter((v) => v._kind === "scroll") : null,
      zoom: chain.find((v) => this.zooms(v) && v._behavior.pinch) ?? null,
      pinch: chain.find((v) => v._gestures?.pinch || v._gestures?.rotation) ?? null,
      // `panActivation`: decided here as the pointer moves (PanActivation::decide).
      gate: chain.find((v) => v._props?.panActivation) ?? null,
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
    if (el._events.has("onLongPress")) {
      p.longTimer = setTimeout(() => {
        p.long = true;
        this.event(el._id, "onLongPress", this.pressPayload(p));
      }, el._props?.longPressDelay ?? 500);
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
    const r = p.press.getBoundingClientRect();
    const [left, top] = this.origin(p.layer);
    return {
      position: { x: p.x + left - r.left, y: p.y + top - r.top },
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
      if (p.pan) {
        p.mode = "pan";
        this.call((w) => w.nsh_pan(p.pan._id, 0, 0, 0, 0, 0));
      } else if (p.scroll && !gated) {
        p.mode = "scroll";
        p.scrollStart = [p.scroll.scrollLeft, p.scroll.scrollTop];
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
      this.call((w) => w.nsh_pan(p.pan._id, 1, tx, ty, vx, vy));
    } else if (p.mode === "scroll") {
      e.preventDefault();
      const s = p.scroll;
      s.scrollLeft = p.scrollStart[0] - tx;
      s.scrollTop = p.scrollStart[1] - ty;
    }
    void dx;
  }

  /** The gate's node id when its pan activates with this move (else undefined). */
  decideGate(p, dx, dy) {
    if (!p.gate || p.gateState !== 0) return undefined;
    const [ax, ay, fx, fy] = p.gate._props.panActivation;
    const past = (limit, d) => limit != null && Math.abs(d) > limit;
    if (past(fx, dx) || past(fy, dy)) {
      p.gateState = 2;
      return undefined;
    }
    const active = ax == null && ay == null ? Math.hypot(dx, dy) > 10 : past(ax, dx) || past(ay, dy);
    if (!active) return undefined;
    p.gateState = 1;
    this.pressOut(p, false);
    return p.gate._id;
  }

  pointerUp(e, cancelled) {
    if (e.pointerType === "mouse") this.hoverButtons = e.buttons;
    const p = this.pointers.get(e.pointerId);
    if (!p) return;
    if (p.mode === "bar") {
      this.pointers.delete(e.pointerId);
      this.releaseBar(p.scroll);
      return;
    }
    if (cancelled && p.scrolls?.length) this.touchScroll(p, this.point(e, p.layer));
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
      this.call((w) => w.nsh_pan(p.pan._id, cancelled ? 3 : 2, p.x - p.startX, p.y - p.startY, vx, vy));
    } else if (p.mode === "scroll") {
      this.scrollEvent(p.scroll, "onScrollDragEnd");
      this.glide(p.scroll, -p.vx, -p.vy);
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
          clearTimeout(v._touchEndTimer);
          v._touchEndTimer = setTimeout(() => {
            v._touchEndTimer = null;
            if (v._released && !v._momentum) this.scrollEnded(v);
          }, 200);
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
    if (s._momentumFrame) {
      cancelAnimationFrame(s._momentumFrame);
      s._momentumFrame = 0;
      this.drive(s, -1);
    }
    let w = Math.abs(vx) > 80 ? vx / 1000 : 0;
    let v = Math.abs(vy) > 80 ? vy / 1000 : 0;
    let last = performance.now();
    const momentum = v !== 0 || w !== 0;
    const end = () => {
      s._momentumFrame = 0;
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
      if (Math.abs(v) > 0.02 || Math.abs(w) > 0.02) s._momentumFrame = requestAnimationFrame(step);
      else end();
    };
    s._momentumFrame = requestAnimationFrame(step);
  }

  startTwoFinger() {
    const [a, b] = [...this.pointers.values()];
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
    const r = el.getBoundingClientRect();
    const [left, top] = this.origin(a.layer);
    const fx = (a.x + b.x) / 2 + left - r.left;
    const fy = (a.y + b.y) / 2 + top - r.top;
    this.twoFinger = { zoom: el, dist: Math.hypot(a.x - b.x, a.y - b.y), scale: el._zoom, point: this.contentPoint(el, fx, fy) };
  }

  moveTwoFinger() {
    const t = this.twoFinger;
    if (t.zoom) {
      const [a, b] = [...this.pointers.values()];
      if (!a || !b) return;
      const r = t.zoom.getBoundingClientRect();
      const [left, top] = this.origin(a.layer);
      t.focus = [(a.x + b.x) / 2 + left - r.left, (a.y + b.y) / 2 + top - r.top];
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
