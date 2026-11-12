# Native file drop

## Scope

Desktop views accept local files and directories dragged from another app.
AppKit, GTK, Win32 and the GPUI backend use the same events and payload; Rust
applications need no JavaScript runtime. Ordinary pointer drags and title-bar
dragging retain their existing behavior. The application decides how to consume
dropped files.

The web backend and the mobile backends deliver no file drags today. A browser
gives a page only each item's kind and MIME type while a drag hovers (names and
contents arrive at the drop, as `File`s, never as local paths), so a web drop
would carry `File`s rather than `file:` URLs and needs its own payload design.

## Contract

- `Interactive::on_file_drag_enter(listener)` receives
  `FileDragEvent { uris, mime_types }` for the active drop destination (unit
  listeners still work); `on_file_drag_leave(listener)` receives a unit event.
- `Interactive::on_file_drop(listener)` receives
  `FileDropEvent { uris, mime_types, page_position }`.
- `mime_types` is derived from each URL's file name in `nsh-core`
  (`platform::file_mime_type`), when a payload is decoded for Rust or JS: the
  platforms send only URLs, no file is read, and every backend reports the
  same type for a name (`""` when the name says none, as `File.type`).
  URIs use `file:` URLs, preserving spaces and escaped filenames. Native code
  converts the platform's local file list; the app can use its existing URL
  parser to obtain paths. Arbitrary text and remote URLs are not file drops.
  AppKit resolves Finder's file reference URLs (`file:///.file/id=…`) to the
  path's URL (`file_drop::local_file_uri`), for drops, pastes and
  `Clipboard.readFiles` alike.
- The native destination is the closest eligible ancestor of the hit view.
  It must listen to FileDrop and be enabled. Native modal roots bound the search.
  Native code answers drag acceptance synchronously from mounted state; it
  never waits for a Rust or JS callback.
- Text inputs are part of the destination around them. AppKit offers a drag
  to the deepest view registered for one of its types, and a text view (a
  text area, the field editor of a focused field) registers for files to
  insert their paths: their drag callbacks (`text_input.rs`) send a drag of
  local files to the destination hit testing finds (`file_drop::text_*`),
  and leave text drags, and files over an input outside any destination, to
  the text view. GTK's text widgets accept strings only and the root's
  capture-phase controller takes the drop first; Win32 and GPUI draw their
  own editors, so hit testing alone routes the drop there.
- Moving between targets emits leave/enter. Leaving the window, cancelling or
  completing the drop clears the active target. Removal/disablement rejects a
  subsequent drop and releases destination state.
- On the GPUI backend the first enter comes with the platform's first move
  report after the drag enters the window, not with the entry itself: the
  layer that receives the drag appears with the drag's next frame.
- The operation is Copy. Delivery means the user dropped the URI list, not that
  the application accepted or read the files. No transfer starts automatically.

## Implementation sequence

1. Add appended event kinds, a typed payload and Rust callbacks. Keep JS
   declaration/payload conversion and Android event numbering synchronized.
   Verify typed delivery, wrong payload rejection and disabled listeners.
2. Add native destination handling in AppKit, GTK and Win32. Reuse each
   platform's hit testing and modal boundaries; keep file lists off pointer
   move paths. Verify nested targets and target removal.
3. Add Rust/TS examples and matching English/Chinese documentation. Run core,
   engine and workspace checks plus native builds and runtime drag exercises.
   Compare counter trace item counts before/after.
4. Open an upstream PR with every public API and exhaustive-match break listed.
   Omasend continues to use upstream main until this capability is merged.

## Acceptance

Drop one file, several files, directories and filenames containing spaces and
non-ASCII characters. Verify disabled targets, nested targets, modal isolation,
window exit/re-entry and cancellation. Verify that Rust callbacks receive the
same URI list as JS callbacks. AppKit, GTK and Win32 runtime evidence is required
before claiming cross-platform completion; off-platform empty-crate builds do
not count as native validation.

## Current evidence

The shared core and JS protocol tests pass (393 tests); the AppKit crate passes
46 unit tests and two doctests with JavaScript disabled, including local URL
filtering and first/last destination registration. AppKit compilation and strict
Clippy pass. The AppKit destination callbacks are implemented, but a real Finder
drag and native target switching have not been exercised. GTK destination
handling now uses a typed GdkFileList controller, the existing hit testing and
first/last-listener registration. It has not been compiled or exercised on Linux;
no additional tests were run at the user's request. Win32 now implements an OLE
IDropTarget with CF_HDROP delivery, screen-to-client coordinates, modal-bounded
hit testing and destination revocation. It has not been compiled or exercised
on Windows. The Rust gallery includes a file-drop destination, and matching
English/Chinese View reference pages show Rust and TSX callbacks. The new example
has not been compiled or exercised. Complete workspace/platform checks, native
drag exercises and trace comparison remain outstanding. This branch is not ready to merge or consume in Omasend.

The GPUI backend passes its unit tests, including a simulated drag that moves
between nested destinations, leaves the window and drops where nothing listens.
A real Finder drag into a GPUI application was exercised on macOS; real drags
into the GPUI backend on Linux and Windows have not been exercised.
