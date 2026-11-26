// The page's script, written by `nsh package --target web` as a file of
// its own (not inline), so a site served with a strict `script-src`
// ('self') starts. It loads the runtime and the app's entry fonts in
// parallel, then imports its browser entry; a chunk's own fonts come with
// it. A Rust app (`app.rust`) has no code: its runtime mounts its root.
// The page's host (`app.host`, nsh.json `web.host`) answers the app's
// `nsh/host` calls: its `createHost(player)` runs once the player exists,
// before the app starts, so no call comes earlier. Its pages and dialogs
// are browser history entries as nsh.json `web.history` says. A shared
// runtime (`nsh package --shared-runtime`) links none of the app's parts of
// `nsh/base`: the side modules the entry needs (`app.entrySides`, requested
// with the main module by the head's script) load before the app starts.
//
// What it starts is in the page (`#nsh-app`, JSON). With nsh.json
// `web.base` its URLs are absolute paths (or the `--asset-url`'s) and the
// site's base is `app.base`, the player's `baseURL`: the page has no
// `<base href>`, which a strict `base-uri` refuses, and is served at every
// route of the app. Without it the URLs are relative to the page. Each is
// resolved once: the app may move the address to another directory before
// a chunk's fonts load. The head's script (`prefetch.js`) keyed its
// requests the same way.
const app = JSON.parse(document.getElementById("nsh-app").textContent);
const url = (path) => new URL(path, document.baseURI).href;
for (const key of ["wasm", "glue", "code", "host"]) if (app[key]) app[key] = url(app[key]);
for (const urls of [app.assets, app.data, app.chunks]) for (const key in urls) urls[key] = url(urls[key]);
for (const name in app.sides) app.sides[name].url = url(app.sides[name].url);
const status = document.getElementById("status");
const fonts = new Map();
let player;

function fail(title, detail) {
  status.hidden = false;
  status.className = "failed";
  status.setAttribute("role", "alert");
  const heading = document.createElement("strong");
  heading.textContent = title;
  const pre = document.createElement("pre");
  pre.textContent = detail;
  status.replaceChildren(heading, pre);
}

// A response the head's script requested (`fetches`) is taken once.
function take(url) {
  const response = fetches.get(url) ?? fetch(url);
  fetches.delete(url);
  return response;
}

async function get(url) {
  const response = await take(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response;
}

const path = (uri) => uri.replace(/^asset:\/+/, "");
// Each font once: before the app starts, or with the chunk that needs it.
const loads = new Map();
const loadFont = (font) => {
  if (!loads.has(font)) {
    loads.set(font, get(app.assets[font]).then(async (r) => fonts.set(font, new Uint8Array(await r.arrayBuffer()))));
  }
  return loads.get(font);
};

try {
  const { createPlayer } = await import(url(app.runtime));
  let host;
  const [loaded, hostModule] = await Promise.all([
    createPlayer(document.getElementById("app"), {
      wasm: take(app.wasm),
      glue: app.glue,
      host: app.host ? { call: (name, args) => host.call(name, args), post: (name, args) => (host.post ?? host.call).call(host, name, args) } : undefined,
      assets: app.assets,
      data: app.data,
      sides: app.sides,
      // A side module the head's script requested (the entry's).
      prefetched: (url) => (fetches.has(url) ? take(url) : undefined),
      // nsh.json `web.history`; without it the player's default.
      history: app.history,
      // nsh.json `web.base`: what the app's relative URLs resolve against.
      baseURL: app.base,
      readAsset: (uri) => fonts.get(path(uri)) ?? null,
      // The chunk's fonts and the side modules of the runtime it needs.
      prepareChunk: (id) => Promise.all([
        ...(app.chunkFonts[id] ?? []).map(loadFont),
        player.loadSides(app.chunkSides?.[id], app.sides),
      ]),
      // A release shows no error box; an app that could not start says so.
      overlay: false,
      onError: (message) => {
        if (!player || player.views.size <= 1) fail("This app could not start.", message);
      },
    }),
    app.host ? import(app.host) : null,
    ...app.fonts.map(loadFont),
    // The fonts of the chunks the entry imports statically.
    ...(app.entryChunks ?? []).flatMap(id => (app.chunkFonts[id] ?? []).map(loadFont)),
  ]);
  player = loaded;
  // While the page's host starts; awaited before the app runs (the empty
  // `catch` only keeps a failure before then from being logged as
  // unhandled).
  const entrySides = player.loadSides(app.entrySides, app.sides);
  entrySides.catch(() => {});
  // The side modules not `onDemand`, downloaded behind its first
  // screen. `nsh package` marks every one it writes `onDemand` (each is
  // code only a lazy chunk or a feature's first use needs), so a side
  // module is fetched when the chunk that needs it is imported.
  player.prefetchSides(app.sides);
  if (hostModule) {
    host = await hostModule.createHost(player);
    if (typeof host?.call !== "function") throw new Error("nsh.json web.host: createHost(player) returned no call(name, args)");
  }
  status.hidden = true;
  // What the page was served with for the app (`#nsh-params`, JSON: data
  // the server already had, so the app need not ask for it again): its
  // `host.params`.
  const served = document.getElementById("nsh-params");
  const params = served ? JSON.parse(served.textContent) : undefined;
  await entrySides;
  if (app.rust) player.runRust();
  else await player.runModule(app.code, { capabilities: app.capabilities ?? "", appId: app.id ?? "", chunks: app.chunks, nativeExports: app.nativeExports, linked: app.linked, params });
  player.preloadSides(app.sides);
} catch (err) {
  fail("This app could not be loaded.", String(err?.message ?? err));
}
