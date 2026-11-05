# Native file drop

## Scope

Desktop views accept local files and directories dragged from another app.
AppKit, GTK, Win32 and the GPUI backend use the same events and payload; Rust
applications need no JavaScript runtime. Ordinary pointer drags and title-bar
dragging retain their existing behavior. The application decides how to consume
dropped files.

## Contract

- `Interactive::on_file_drag_enter(listener)` and `on_file_drag_leave(listener)`
  receive unit events for the active drop destination.
- `Interactive::on_file_drop(listener)` receives `FileDropEvent { uris }`.
  URIs use `file:` URLs, preserving spaces and escaped filenames. Native code
  converts the platform's local file list; the app can use its existing URL
  parser to obtain paths. Arbitrary text and remote URLs are not file drops.
- The native destination is the closest eligible ancestor of the hit view.
  It must listen to FileDrop and be enabled. Native modal roots bound the search.
  Native code answers drag acceptance synchronously from mounted state; it
  never waits for a Rust or JS callback.
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
