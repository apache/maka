# Maka Skin Runtime

Maka skins are trusted local UI mods packaged as ZIP-compatible
`.maka-skin` files. They can combine global CSS with JavaScript running in a
dedicated Chromium isolated world.

## Package

```text
my-skin.maka-skin
├── manifest.json
├── theme.css
├── entry.mjs
├── preview.webp
└── assets/
```

`manifest.json` uses schema version 1:

```json
{
  "schemaVersion": 1,
  "id": "author.skin-name",
  "name": "Skin name",
  "version": "1.0.0",
  "styles": "theme.css",
  "entry": "entry.mjs",
  "permissions": ["dom", "canvas", "storage"]
}
```

The entry module must be self-contained and export
`activate(api)`. It may return a cleanup function. Static or dynamic imports
are rejected in schema version 1.

## Runtime API

- `api.apiVersion`: host API contract version (`1`).
- `api.manifest`: validated manifest metadata.
- `api.overlay`: a skin-owned, automatically removed overlay element.
- `api.assets.url(path)`: data URL for a file under `assets/`.
- `api.assets.list()`: available asset paths.
- `api.appearance.current()` / `onDidChange(handler)`: theme preference,
  resolved mode, palette, forced colors, contrast, reduced motion, and reduced
  transparency.
- `api.appearance.tokens`: read all resolved Maka design tokens, set dynamic
  per-skin overrides, and reset them. Overrides are restored automatically
  when the skin is disabled.
- `api.parts.one(name)` / `all(name)`: stable `[data-maka-part]` anchors.
- `api.parts.observe(name, handler)`: follow anchors across React remounts.
- `api.parts.wait(name)`: wait for a lazy or conditional surface.
- `api.state.current()` / `onDidChange(handler)`: navigation, streaming,
  active-session, and modal state. The first callback receives the current
  snapshot immediately.
- `api.environment.current()` / `onDidChange(handler)`: locale, platform,
  viewport, pixel ratio, touch input, and appearance accessibility preferences.
- `api.styles.add(css, id)`: add, update, and dispose runtime-generated CSS.
- `api.lifecycle.onDispose(handler)`: register cleanup without returning one
  combined function from `activate`.
- `api.storage`: JSON `get`, `set`, and `remove`, namespaced by skin id.
- `api.log(...)`: namespaced development logging.

The authoring declaration is [`skin-api.d.ts`](./skin-api.d.ts). Editors can
use it from JavaScript with:

```js
/** @param {import("../../../docs/skin-api").MakaSkinApi} api */
export function activate(api) {}
```

The manifest schema is
[`skin-manifest.schema.json`](./skin-manifest.schema.json).

### Stable parts

Schema version 1 exposes:

`app`, `shell`, `titlebar`, `sidebar`, `main`, `detail-panel`, `chat`,
`chat-header`, `transcript`, `composer`, `composer-interactions`, `settings`,
`settings-sidebar`, `settings-content`, and `command-palette`.

Use `observe` or `wait` for conditional surfaces such as Settings and the
command palette. Do not depend on private class names when a stable part exists.

### Normal appearance path

Maka remains the authority for the user's `light` / `dark` / `auto`
preference and base palette. A skin observes the resolved host appearance and
overrides semantic CSS custom properties. Host changes continue to update the
native Electron theme, title-bar overlay, startup cache, and persisted
settings; skins should not replace those mechanisms.

The authoritative token surface includes colors, typography, spacing, radii,
elevation, motion, layout, and z-index variables from `maka-tokens.css`.
`api.appearance.tokens.all()` returns the resolved catalog at runtime.

The isolated world can access the DOM and browser APIs such as Canvas, WebGL,
Web Audio, observers, and animations. It cannot access Node.js or Maka's
`window.maka` preload bridge.

## Recovery and trust

Skins are intentionally powerful and should be treated like local plugins.
The installer displays a full-access warning. If activation does not finish,
the next launch disables the skin automatically. Launching Maka with
`--disable-skins` (or `MAKA_DISABLE_SKINS=1`) bypasses all skins.

Importing a package with the same skin id updates it in place. The Appearance
settings page can reload the active package immediately or remove an installed
package. These actions do not require rebuilding or restarting Maka.

To package the included example:

```sh
cd examples/skins/neon-orbit
zip -r ../neon-orbit.maka-skin manifest.json theme.css entry.mjs preview.svg
```
