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

- `api.manifest`: validated manifest metadata.
- `api.overlay`: a skin-owned, automatically removed overlay element.
- `api.assets.url(path)`: data URL for a file under `assets/`.
- `api.assets.list()`: available asset paths.
- `api.parts.one(name)` / `all(name)`: stable `[data-maka-part]` anchors.
- `api.events.on('state', handler)`: navigation, streaming, and modal state.
- `api.storage`: JSON `get`, `set`, and `remove`, namespaced by skin id.
- `api.log(...)`: namespaced development logging.

The isolated world can access the DOM and browser APIs such as Canvas, WebGL,
Web Audio, observers, and animations. It cannot access Node.js or Maka's
`window.maka` preload bridge.

## Recovery and trust

Skins are intentionally powerful and should be treated like local plugins.
The installer displays a full-access warning. If activation does not finish,
the next launch disables the skin automatically. Launching Maka with
`--disable-skins` (or `MAKA_DISABLE_SKINS=1`) bypasses all skins.

To package the included example:

```sh
cd examples/skins/neon-orbit
zip -r ../neon-orbit.maka-skin manifest.json theme.css entry.mjs
```
