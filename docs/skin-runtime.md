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

New packages should use schema version 2. The runtime remains compatible with
schema version 1 packages:

```json
{
  "schemaVersion": 2,
  "minimumApiVersion": 2,
  "requiredCapabilities": ["appearance.v1", "parts.v1", "slots.v1"],
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
are rejected in every supported schema version.

## Runtime API

- `api.apiVersion`: host API contract version (`2`).
- `api.capabilities`: detect stable host features without probing private DOM.
- `api.permissions`: inspect the permissions granted by the installed manifest.
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
- `api.slots.one(name)` / `wait(name)`: find formal extension surfaces around
  the chat header, transcript, and composer.
- `api.slots.mount(name)`: create a skin-owned mount that survives React
  rerenders and is removed automatically when the skin is disabled.
- `api.state.current()` / `onDidChange(handler)`: navigation, streaming,
  active-session, and modal state. The first callback receives the current
  snapshot immediately.
- `api.environment.current()` / `onDidChange(handler)`: locale, platform,
  viewport, pixel ratio, touch input, and appearance accessibility preferences.
- `api.styles.add(css, id)`: add, update, and dispose runtime-generated CSS.
- `api.events.on(type, handler)`: subscribe to redacted semantic session,
  message-count, generation, tool-status, and interaction lifecycle events.
- `api.actions.can(name)` / `invoke(name, input)`: request a controlled host
  action. Every action requires its matching manifest permission and one recent
  trusted click or key press in skin-owned UI; one gesture authorizes one
  action only.
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

### Stable slots

API version 2 exposes `chat-header-before`, `chat-header-after`,
`transcript-before`, `transcript-after`, `composer-before`, and
`composer-after`. A slot is a host-owned location, while the element returned
by `mount` belongs to the skin.

### Controlled actions

The action permissions are deliberately granular:

- `actions.navigation` → `navigation.switch-session`
- `actions.task` → `task.new`
- `actions.submit` → `composer.submit`
- `actions.stop` → `generation.stop`

`composer.submit` is rejected while the composer is busy or owns staged user
attachments, quotes, a revision, or a permission/question interaction. Skins
never receive the Maka preload bridge, and Maka shows a native confirmation
with a prompt preview before every `composer.submit` request.

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
`window.maka` preload bridge. Because DOM, Canvas, and Web Audio are browser
capabilities of the same isolated world, their manifest entries describe the
skin's declared intent for installation review; they are not separate process
sandboxes. Controlled host actions are separately enforced in the main
process. A DOM-enabled skin is nevertheless a full-trust UI mod: arbitrary DOM
JavaScript can imitate page interaction outside the stable Skin API, so the
installer labels that permission explicitly instead of presenting action
permissions as an absolute sandbox.

## Recovery and trust

Skins are intentionally powerful and should be treated like local plugins.
The installer previews the exact requested permissions before writing the
package. If activation does not finish,
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
