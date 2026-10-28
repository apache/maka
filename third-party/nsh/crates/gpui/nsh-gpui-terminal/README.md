# GPUI terminal transport

This Linux transport embeds the existing NSH GPUI `AppView`, using the host's
original `EngineConfig`. It renders the same scene with the production WGPU
offscreen API. It supplies neither a second application runtime nor terminal IO.
The transport uses the official GPUI Fast 0.1.10 core. Only the WGPU renderer
is received under `third-party/gpui-wgpu`, where its own `offscreen` feature
exposes production pixel readback. `test-support` is not a production dependency.

The host constructs `gpui_wgpu::WgpuHeadlessRenderer` and creates `TerminalPlatform`, uses `Application::with_platform` and
`run_embedded`, and pumps foreground work when woken or a timer is due. One
native window is supported. The shared background executor uses one fewer worker
than the host's available parallelism, with at least one worker. The foreground
pump runs at most 64 jobs. Frames are requested when dirty; there
is no imposed 60 Hz timer. Input, CPU layout, painting and GPU command encoding
stay on the native UI path. Drawing hands owned commands to the host's existing
background executor for GPU submission, readback and terminal image encoding.
The host waits for actual submission to return before encoding the next scene,
preserving GPU queue-write order. Readback, image encoding and terminal output
can still overlap native work and later frames. This API does not establish a
frame-rate or input latency result.
`pump_with_draw(false)` still runs foreground and window lifecycle work while
the output pipeline is full. It preserves the original dirty frame without
re-waking just for that deferred draw; the host allows drawing once a candidate
slot is available. `has_pending()` includes that dirty frame for scheduling.

The sole terminal input and output owners remain in the embedding application.
Use actual terminal pixel dimensions for resize and actual negotiated pixel
mouse reports. Coordinates supplied to this platform are physical pixels at
scale 1; it does not guess cell dimensions or synthesize pixel precision from
cell reports. Keyboard callbacks run before the current native text handler
commits a propagated printable character. A bracketed paste is one text commit.

A host with a negotiated composition producer keeps `text_input_target()` on
the native owner thread and applies each complete update with
`apply_composition(target, commit_prefix, preedit, selection_utf16, active)`.
The selection is relative to the preedit, in UTF-16 code units. An inactive
update cancels its temporary mark. The committed prefix is applied first; if
that edit changes the focused field, the remaining preedit is discarded.
The target identifies a native focus admission, so leaving and returning to
the same field also invalidates it. The host binds each source composition
lifetime to one such target and negotiates application admission separately;
field changes do not require a transport round trip.

`input_candidate_bounds()` returns the native IME anchor on the current visual
line, with its full height, in logical window pixels. Convert all four edges
to terminal units and retain any zero-width rectangle. `input_caret_bounds()`
continues to report the actual caret independently.

Each successful scene preparation produces a `PreparedFrame` containing an
issuer-bound `FrameToken`, viewport generation and owned GPU commands. On the
background executor, `submit()` yields a `SubmittedFrame`; its `complete()`
produces a `CandidateFrame` with tightly packed RGBA8 pixels. All three stages
retain the same candidate identity. A token is not an output receipt, and
neither submission nor completion samples application state again.
Retain one output transaction in flight and one replaceable pending candidate.
Once any wire byte is written, complete the entire transaction indivisibly.

The renderer checks actual texture dimensions and readback-buffer limits before
allocating pixels. Encoder output writers use fallible allocations without an
additional per-frame byte quota.
Only a successful, unmapped staging buffer returns to the renderer's single
reuse cache. Dropping a pending ticket cancels mapping and discards its buffer.

`KittyFrame::encode` prepares a complete lossless PNG/base64 snapshot without
choosing an image slot. The sole writer binds the alternate owned slot with
`KittyFrame::into_wire`, which positions the cursor at the origin, chunks the
payload at the protocol's 4096-byte boundary and retains the last acknowledged
image underneath. The complete `q=0` upload must flush and receive its matching
success reply before the native owner calls `mark_presented`. Preparation and
GPU rendering can overlap without reusing a slot whose receipt is pending.
The sole reader ends the graphics session on any negative reply for either
owned slot, including a late error. The independent capability query still
requires a positive reply, and its nonce must differ from both image slots.
Restoration deletes only those owned slots.

Resize immediately revokes the old viewport's output receipt. Discard its
pending candidate, finish any already-started output indivisibly, and recreate
the next frame at the new dimensions. A GPU completion is a candidate, not a
terminal publication. The native owner consumes the writer's completed receipt
before calling `mark_presented`; that receipt does not prove display vsync.

Incoming events stay in physical order and use `dispatch_input` through GPUI's
ordinary native handlers. Output receipts, pending draws and frame tokens do
not authorize or delay input. `AppView::cancel_pointer` clears the current
native mouse contact when the terminal loses it, without changing field focus.
Native window handles, webview portals and OS path pickers are unsupported.
Clipboard writes are returned to the host for its unique output owner.

The GPUI workspace patches only `gpui-fast-wgpu` to that relative source
directory; the main workspace excludes this renderer package. Build the GPUI workspace directly; no Maka
checkout or absolute dependency path is needed. Renderer tests use
`--features offscreen,test-support`; the production terminal dependency uses
only `offscreen` and `font-kit`.
