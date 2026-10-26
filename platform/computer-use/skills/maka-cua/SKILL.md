---
name: maka-cua
description: Operate native apps and connected browser tabs through Maka's independent Computer Use REPL. Use for UI tasks that need accessibility observations, screenshots and bound input.
allowed-tools:
  - tool_search
  - cua_repl
  - cua_reset
required-tools:
  - cua_repl
---

# Maka Cua

Discover `cua_repl` with `tool_search` and call it directly. It has a persistent
JavaScript environment independent of Code Mode. Variables and bindings survive
calls and Turns within the current Host process; a Host restart or `cua_reset`
clears them. Current tool results supersede an earlier REPL-state snapshot.

Discovery and selection emit API documentation and inventory or initial state:

```js
await cua.getState();
const app = await cua.getApp("Calculator");
const tab = await cua.getTab({ url: "https://example.com" });
```

These are alternative entry points. `getApp({windowId})` selects an exact window.
macOS can launch a named app; Linux requires an open window. Windows can launch
an inventory app ID with `cua.computer.launch_app`, then bind its open window.
Browser IDs identify configured CDP providers and their existing profiles; when
none is configured, browser windows remain accessible through `cua.getApp`.
Desktop selection and browser endpoints come from configuration.

The emitted API reference covers platform-specific methods. On tabs, `typeText`,
`paste` and `pressKey` take an observed element index or `null` for current focus.
Secondary actions use names listed in the native accessibility state.

`getAXState`, `getScreenshot` and `getAXStateAndScreenshot` emit automatically.
Use `{emit:false}` for programmatic inspection; inventory failures still appear.
`nodeRepl.write(value)` and `await nodeRepl.emitImage(image)` emit explicit output.
There is no Node, arbitrary filesystem or network API.

Coordinates require a current screenshot; moving/resizing, navigation or input
invalidates them. Screenshot-only and failed observations clear accessibility
indices. Stale targets require a fresh observation or target binding. Input
acknowledgment and cursor animation do not establish the resulting application
state. Reported uncertain effects may already have occurred; repeating input
can duplicate them.

Cancellation, timeout or heap exhaustion requires `cua_reset` and target rebinding.
Reset leaves user apps and tabs open and does not undo dispatched input. Every
operation uses current Host permissions; retained objects do not retain grants.

`cua.computer.target` identifies the desktop platform. In WSL it defaults to the
Windows host while shell commands may run in Linux. Input automatically shows
this Session's Maka cursor.
`cua.cursor.configure` controls its display. Cursors do not isolate keyboard focus.
