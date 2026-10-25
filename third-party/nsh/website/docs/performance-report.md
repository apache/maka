---
title: Performance report
description: Measured numbers of NSH apps - commit and frame costs from NSH's baselines, and the gallery's frame rate, CPU and memory page by page on Linux, macOS, Windows and iOS - with how to reproduce them.
order: 62.5
group: tools
---

# Performance report

What NSH apps cost, measured. How NSH keeps them fast and how to measure your own app is in [Performance](./performance.md).

## Baselines

From NSH's own baselines (Apple silicon unless noted):

| Scenario | Numbers |
|---|---|
| Counter app, headless (debug) | First frame ~0.5–0.65 ms (58 ops / 49 mount items); one tap ~0.15 ms |
| Counter app, Mac Catalyst (release) | First frame ~1.05–1.15 ms (about 0.7 ms of it lays out 10 texts with CoreText for the first time); one tap ~0.12 ms |
| Gallery photo list, headless (debug) | First frame 653 ops / 224 nodes, ~2.7 ms |
| Scrolling the photo list, Catalyst (release) | Rebinding one row while scrolling slowly ~0.4 ms; a whole screen of ~32 rows on a fast fling 0.9–1.6 ms |
| Scrolling the photo list, Android emulator (arm64, release) | Rebinding one row ~0.3–0.4 ms (JS ~60 µs) |
| Engine startup (release) | ~75–155 µs; the global APIs (`fetch`, `URL`, ...) cost nothing until first used, then ~90 µs |
| Hot reload | ~120 ms from saving a file to the new version running; applying the update 0.2–0.5 ms |

## Linux (GTK 4)

Measured on a Linux desktop (x86_64, 24 threads, NVIDIA GPU), release builds, the gallery in a 1896 × 1030 window on a
120 Hz display, every reading taken automatically by `examples/gallery/tools/perf.py` (`nsh test --target linux --fps`,
one line a second; CPU is the whole process, in percent of one core). *Frame p95* is the main thread's time per drawn
frame at the 95th percentile: under 8.3 ms, a frame fits a 120 Hz refresh.

### Animated demos

<div class="data-table">

| Demo | FPS | Frame p95 | CPU |
|---|---|---|---|
| Stocks: 22 live sparklines, an intraday chart, order book, tape | 117–120 | 5–6 ms | 25–29% (1200 × 800), 28–32% (1896 × 1030) |
| Stocks, the window filling a 4K 144 Hz display at 1.6× | 143–145 | 4.1–4.4 ms | 26–29% |
| Canvas: a gauge, a clock, a dot matrix | 120 | 2.6–4.4 ms | 5–10% |
| Animations: three native loops, springs, sequences | 120 | 2.0 ms | 12–13% |

</div>

### Every page

Every page of the gallery, as it opens and while the test scrolls it, in a 1200 × 800 window on a 144 Hz display (the
same machine). NSH draws a frame only when something on screen changes, so *FPS* here is the rate while something
moves: one frame per median gap between drawn frames (`perf.py`'s `moving`); at the display's 144, every frame of an
animation or a scroll comes one refresh after the last. *Over one refresh* is the share of frames that took longer
than a refresh (6.9 ms). Images' GIF and WebP play at their own frame rates (about 50 FPS here), as does video. Physics, Overlays and Menus are short: in 1200 × 800 a scroll reaches their end within a few frames, so they are measured in a 900 × 500 window, where they have room to scroll.

<div class="data-table">

| Page | Frames come from | FPS | Frame p95 | Over one refresh | CPU |
|---|---|---|---|---|---|
| Stocks | Live data, native loops | 144 | 4.1 ms | 0% | 26% |
| Stocks, scrolling | Live data, scroll | 144 | 4.1 ms | 0% | 25% |
| Photos, scrolling | Scroll | 144 | 2.8 ms | 2% | 9% |
| Lists, scrolling | Scroll | 143 | 1.7 ms | 0% | 7% |
| Scrolling, scrolling | Scroll | 144 | 1.6 ms | 1% | 4% |
| Navigation, scrolling | Scroll | 143 | 1.7 ms | 0% | 2% |
| Form, scrolling | Scroll | 144 | 1.3 ms | 0% | 4% |
| Resizable, scrolling | Scroll | 143 | 0.6 ms | 0% | 1% |
| Dock, scrolling | Scroll | 142 | 0.5 ms | 1% | 1% |
| Gestures | Springs, a pulsing ring | 144 | 1.6 ms | 0% | 1–5% |
| Physics, scrolling | Scroll (a 900 × 500 window) | 144 | 1.6 ms | 1% | 1% |
| Animations | Native loops | 144 | 2.6 ms | 0–1% | 5% |
| Canvas, scrolling | Scroll, native loops | 144 | 4.2 ms | 0% | 1–4% |
| Styles, scrolling | Scroll | 144 | 2.3 ms | 2% | 3% |
| Tailwind | `animate-*` utilities | 144 | 1.7 ms | 0% | 3–8% |
| Text, scrolling | Scroll | 144 | 1.9 ms | 0% | 4% |
| Text View, scrolling | Scroll | 141 | 1.8 ms | 2% | 7% |
| Images, scrolling | Scroll, GIF and WebP frames | 143 | 2.9 ms | 2% | 8% |
| Components, scrolling | Scroll | 144 | 1.4 ms | 0% | 3% |
| Overlays, scrolling | Scroll (a 900 × 500 window) | 144 | 1.7 ms | 0% | 2% |
| Menus, scrolling | Scroll (a 900 × 500 window) | 144 | 1.9 ms | 0% | 2% |
| Controls | Transitions | 144 | 0.9 ms | 0% | 1–4% |
| Web and video | Video frames, the page | 135–142 | 1.0 ms | 0% | 7–8% |

</div>

### Memory

At rest, 3 s after start (release runners, a 480 × 640 window). *Private* is the memory the process alone owns (USS);
*resident* adds the shared libraries' pages (GTK, the GPU driver), which every GTK app on the machine shares:

<div class="data-table">

| App | Renderer | Private (USS) | Resident (RSS) |
|---|---|---|---|
| Rust app (`nsh init --template rust`) | GL (`ngl`) | ~49 MB | ~142 MB |
| Rust app | Cairo (`GSK_RENDERER=cairo`) | ~28 MB | ~95 MB |
| TSX counter (`examples/counter`) | GL | ~79 MB | ~166 MB |
| GTK 4 window with one label, for reference | Vulkan / Cairo | ~62 / ~40 MB | ~132 / ~109 MB |

</div>

Revisiting a page adds no memory; the first visit to a page grows the process by what it caches on purpose (decoded
images, bounded at 128 MB) and the libraries it loads on first use (WebKitGTK for web views).

### App size

A hello world app made by `nsh init` with each template, and two apps people use, as `nsh package --target linux`
builds them for x86_64. The runner is the app's one executable; the archive is the `.tar.gz` it ships as. The hello
worlds are built with link-time optimization and stripped (`CARGO_PROFILE_RELEASE_LTO=fat`,
`CARGO_PROFILE_RELEASE_CODEGEN_UNITS=1`, `CARGO_PROFILE_RELEASE_STRIP=true`):

<div class="data-table">

| App | Written in | Runner | Archive |
|---|---|---|---|
| Hello world (`--template rust`) | Rust | 16.5 MB | 7.5 MB |
| Hello world (`--template ts`) | TSX, on QuickJS | 25.7 MB | 11.6 MB |
| Hello world (`--template mixed`) | TSX and a Rust crate | 25.8 MB | 11.7 MB |
| [sysmon](https://github.com/huacnlee/sysmon) 0.1.3 | Rust | 20.9 MB stripped | 9.7 MB |
| [Omasend](https://github.com/huacnlee/omasend) 0.2.0 | Rust | 22.3 MB | 9.8 MB |

</div>

The TSX runners hold the QuickJS runtime, the native modules and the renderer; an app's own code is its bundle beside
the runner, under 1 KB for a hello world.

What makes these numbers:

- **The renderer**: under NVIDIA's driver NSH draws with GSK's GL renderer, whose frames cost a fraction of the Vulkan
  renderer's there (the Animations demo: ~1 ms of drawing per frame instead of ~9.5 ms). `GSK_RENDERER` still chooses.
- **Canvas rasters**: each canvas is rasterized once into 256 px tiles kept on the GPU. An animated value redraws only
  the area the operations reading it cover, over the kept pixels of the drawing's static part; a canvas out of sight
  waits until it scrolls into view.
- **Paths set aside once**: `fillRect` and `fillText` after a long path leave it in place until it is used again (a
  400-point line then 240 bars: 0.63 ms).

## macOS (AppKit)

Measured on a MacBook Pro (Apple M3, 24 GB) on its built-in 120 Hz ProMotion display, release builds, the gallery in
a 1200 × 800 window, every reading taken automatically by `examples/gallery/tools/perf.py` (`nsh test --target macos
--fps`, one line a second; CPU is the whole process, in percent of one core, GPU its share of the GPU). The phases are
the main thread's per frame: *tick* (the display link's native animations) and *canvas* (replaying drawings).

### Animated demos

<div class="data-table">

| Demo | FPS | Frame p95 | CPU | GPU |
|---|---|---|---|---|
| Stocks: 22 live sparklines, an intraday chart, order book, tape | 120 | 2.7–3.7 ms | 33–36% | 18–22% |
| Canvas: a gauge, a clock, a dot matrix | 119–120 | 0.6–0.7 ms | 4–7% | 0% |
| Animations: three native loops, springs, sequences | 119–120 | 0.3–1.6 ms | 5–8% | 0% |

</div>

On Stocks a frame's main-thread time is ~1.6 ms of ticks, of which ~0.45 ms replays the canvases' animated parts;
Core Animation draws the rest of each canvas on its own threads.

### Every page

Every page of the gallery, as it opens and while the test scrolls it, in the same 1200 × 800 window. As on Linux, *FPS*
is the rate while something moves (one frame per median gap between drawn frames); at the display's 120, every frame
of an animation or a scroll comes one refresh after the last. *Over one refresh* is the share of frames that took
longer than a refresh (8.3 ms). A page at rest draws no frame and uses 2–5% CPU. Images' GIF and WebP play in Core
Animation and video in AVFoundation, at their own frame rates.

<div class="data-table">

| Page | Frames come from | FPS | Frame p95 | Over one refresh | CPU |
|---|---|---|---|---|---|
| Stocks | Live data, native loops | 120 | 3.2 ms | 0% | 35% |
| Stocks, scrolling | Live data, scroll | 120 | 3.5 ms | 0% | 36% |
| AI Chat, scrolling | Scroll | 120 | 2.4 ms | 1% | 5% |
| Photos, scrolling | Scroll | 120 | 1.4 ms | 0% | 10% |
| Lists, scrolling | Scroll | 120 | 1.6 ms | 0% | 8% |
| Scrolling, scrolling | Scroll | 120 | 2.7 ms | 0% | 6% |
| Navigation, scrolling | Scroll | 120 | 0.2 ms | 0% | 4% |
| Form, scrolling | Scroll | 120 | 0.6 ms | 0% | 5% |
| Resizable, scrolling | Scroll | 120 | 0.3 ms | 0% | 4% |
| Dock, scrolling | Scroll | 120 | 0.3 ms | 1% | 5% |
| Gestures | Springs, a pulsing ring | 120 | 0.4 ms | 0% | 4% |
| Physics, scrolling | Scroll | 120 | 0.3 ms | 0% | 4% |
| Animations | Native loops | 120 | 0.3 ms | 0% | 5% |
| Canvas, scrolling | Scroll, native loops | 120 | 1.2 ms | 0% | 7% |
| Styles, scrolling | Scroll, a swaying transform | 120 | 1.0 ms | 0% | 6% |
| Tailwind | `animate-*` utilities | 120 | 0.5 ms | 0% | 4% |
| Text, scrolling | Scroll | 120 | 0.3 ms | 0% | 5% |
| Text View, scrolling | Scroll | 120 | 0.7 ms | 0% | 5% |
| Images, scrolling | Scroll | 120 | 0.4 ms | 0% | 5% |
| Components, scrolling | Scroll | 120 | 0.3 ms | 0% | 5% |
| Overlays, scrolling | Scroll | 120 | 0.3 ms | 0% | 4% |
| Menus, scrolling | Scroll | 120 | 0.3 ms | 0% | 5% |
| Controls | Transitions | 120 | 0.3 ms | 0% | 4% |
| Web and video, scrolling | Scroll | 120 | 0.2 ms | 0% | 6% |
| System | `requestAnimationFrame`, timers | 120 | 0.2 ms | 0% | 3% |
| Standard APIs, scrolling | Scroll | 120 | 0.3 ms | 0% | 5% |
| Storage, scrolling | Scroll | 120 | 0.3 ms | 0% | 5% |

</div>

### Memory

At rest, 3 s after start (release runners). *Footprint* is the memory macOS charges the process (what Activity
Monitor shows); *resident* adds the pages of the system's shared libraries:

<div class="data-table">

| App | Window | Footprint | Resident (RSS) |
|---|---|---|---|
| Rust app (`nsh init --template rust`) | 1200 × 800 | ~19 MB | ~86 MB |
| TSX counter (`examples/counter`) | 1200 × 800 | ~20 MB | ~89 MB |
| AppKit window with one label, for reference | 480 × 640 | ~17 MB | ~80 MB |

</div>

Through the gallery's tour the process holds 84–230 MB up to the Canvas page and ~350–360 MB from the Text View page
on, with what it caches on purpose (decoded images, bounded at 128 MB; the Text View page's documents) and the
frameworks it loads on first use (WebKit for web views); the Canvas page's rasters, up to ~310 MB with all three
canvases on screen, go when the page closes.

### App size

The hello world apps made by `nsh init` with each template, as `nsh package --target macos` builds them for Apple
silicon (arm64), with link-time optimization and stripped as on Linux, and the two apps above as they ship for Apple
silicon. The executable is the runner inside the `.app`; the zip is the `.app` compressed (`ditto -c -k`):

<div class="data-table">

| App | Written in | Executable | Zipped `.app` |
|---|---|---|---|
| Hello world (`--template rust`) | Rust | 12.4 MB | 6.0 MB |
| Hello world (`--template ts`) | TSX, on QuickJS | 19.8 MB | 9.5 MB |
| Hello world (`--template mixed`) | TSX and a Rust crate | 19.8 MB | 9.5 MB |
| [sysmon](https://github.com/huacnlee/sysmon) 0.1.3 | Rust | 21.6 MB | 8.4 MB (its release's `.tar.gz`) |
| [Omasend](https://github.com/huacnlee/omasend) 0.2.0 | Rust | 18.4 MB | 9.7 MB (its release's `.tar.gz`) |

</div>

What makes these numbers:

- **Frames only for changes**: the display link ticks while a native animation runs and stops with it; an animation
  stops with its page (its view's deletion ends its keyframes, a loop stops in its component's `cleanup`).
- **Canvases drawn where they cost least**: a canvas that paints often (an animation, live data) draws on Core
  Animation's threads (`drawsAsynchronously`), which keeps the main thread free; one redrawn now and then draws at
  once, without the graphics memory asynchronous drawing holds. An animated value redraws only the area the
  operations reading it cover.
- **Static canvas parts kept**: once a drawing stays unchanged, a long part before its first animated operation is
  kept as a layer; each frame draws that layer and replays only the animated rest, at once on the main thread (the
  Canvas page's gauge, clock and dot matrix: no GPU work and half the memory).
- **Content drawn when it changes**: texts and canvases draw into layers of their own, again when their content or
  size changes, not when they move or scroll.

## Windows (Win32, Direct2D)

Measured on a Windows 11 desktop (Intel Core i7-13700KF, 32 GB, NVIDIA GeForce RTX 3060 Ti) on a 4K 144 Hz display at
150%, release builds, the gallery in a 1200 × 800 window (1800 × 1200 pixels), every reading taken automatically by
`examples/gallery/tools/perf.py` (`nsh test --target windows --fps`, one line a second; CPU is the whole process, in
percent of one core). The phases are the main thread's per frame: *paint* (Direct2D drawing the window) and, within
it, *canvas* (recording and replaying drawings).

### Animated demos

<div class="data-table">

| Demo | FPS | Frame p95 | Paint / canvas per frame | CPU |
|---|---|---|---|---|
| Stocks: 22 live sparklines, an intraday chart, order book, tape | 144 | 3.7–4.3 ms | 1.4 / 0.13 ms | 36–43% |
| Canvas: a gauge, a clock, a dot matrix | 144 | 1.0–2.0 ms | 0.8–1.4 / 0.05 ms | 21–35% |
| Animations: three native loops, springs, sequences | 144 | 1.0–3.6 ms | 0.9–1.9 ms | 20–41% |

</div>

Stocks commits 16–17 times a second, each in up to 2.1 ms of JS and 1.7 ms of the core on the engine thread (p95).

> [!NOTE]
> Pages whose animations move views across large areas take more CPU here than on Linux and macOS (Animations 20–41%
> against 5–13%, Gestures 36% against 1–5%). A Windows frame draws again, with Direct2D on the main thread, every view
> over the areas that changed: a ring that grows redraws the card under it on every frame. On macOS Core Animation
> moves, scales and fades the layers it keeps on the GPU without drawing them again, and on Linux GSK keeps the
> render nodes of what did not change. The numbers also count 144 frames a second at 1800 × 1200 pixels.

### Every page

Every page of the gallery, as it opens and while the test scrolls it, in the same 1200 × 800 window. As on Linux and
macOS, *FPS* is the rate while something moves (one frame per median gap between drawn frames); at the display's 144,
every frame of an animation or a scroll comes one refresh after the last. *Over one refresh* is the share of frames
that took longer than a refresh (6.9 ms). A page at rest draws no frame and uses 0–2% CPU. Images' GIF and WebP play
at their own frame rates (about 40 FPS here). Physics, Overlays, Menus and Storage are measured in a 900 × 500 window,
where they have room to scroll.

<div class="data-table">

| Page | Frames come from | FPS | Frame p95 | Over one refresh | CPU |
|---|---|---|---|---|---|
| Stocks | Live data, native loops | 144 | 3.9 ms | 0% | 36% |
| Stocks, scrolling | Live data, scroll | 144 | 4.3 ms | 0% | 43% |
| Photos, scrolling | Scroll | 143 | 2.1 ms | 0% | 9% |
| Lists, scrolling | Scroll | 144 | 2.0 ms | 1% | 19% |
| Scrolling, scrolling | Scroll | 143 | 2.1 ms | 0% | 7% |
| Navigation, scrolling | Scroll | 144 | 0.8 ms | 0% | 9% |
| Form, scrolling | Scroll | 144 | 0.8 ms | 0% | 12% |
| Resizable, scrolling | Scroll | 143 | 0.4 ms | 0% | 4% |
| Dock, scrolling | Scroll | 144 | 0.5 ms | 1% | 5% |
| Gestures | Springs, a pulsing ring | 144 | 1.8 ms | 0% | 36% |
| Physics, scrolling | Scroll (a 900 × 500 window) | 144 | 0.8 ms | 0% | 4% |
| Animations | Native loops | 144 | 1.0 ms | 0% | 28% |
| Canvas, scrolling | Scroll, native loops | 144 | 2.0 ms | 0% | 35% |
| Styles, scrolling | Scroll, a swaying transform | 144 | 2.1 ms | 0% | 39% |
| Tailwind | `animate-*` utilities | 144 | 0.6 ms | 0% | 19% |
| Text, scrolling | Scroll | 144 | 1.6 ms | 0% | 8% |
| Text View, scrolling | Scroll | 144 | 1.1 ms | 0% | 10% |
| Images, scrolling | Scroll, GIF and WebP frames | 143 | 4.8 ms | 2% | 23% |
| Components, scrolling | Scroll | 144 | 1.0 ms | 1% | 11% |
| Overlays, scrolling | Scroll (a 900 × 500 window) | 144 | 0.6 ms | 0% | 1% |
| Menus, scrolling | Scroll (a 900 × 500 window) | 144 | 0.6 ms | 0% | 2% |
| Controls | Transitions | 117–144 | 1.5 ms | 0% | 22% |
| Web and video, scrolling | Scroll | 144 | 1.6 ms | 0% | 15% |
| System | `requestAnimationFrame`, timers | 144 | < 0.1 ms | 0% | 1% |
| Storage, scrolling | Scroll (a 900 × 500 window) | 144 | 0.5 ms | 0% | 1% |

</div>

### Memory

At rest, 3 s after start (release runners, a 1200 × 800 window). *Private working set* is the memory the process
alone uses (Task Manager's Memory column); *private bytes* what it has committed; *working set* adds the pages of the
system's libraries it shares with other processes (Direct3D, Direct2D, DirectWrite, the GPU driver):

<div class="data-table">

| App | Private working set | Private bytes | Working set |
|---|---|---|---|
| Rust app (`nsh init --template rust`) | ~14 MB | ~60 MB | ~53–71 MB |
| TSX counter (`examples/counter`) | ~15 MB | ~61 MB | ~56–71 MB |

</div>

Through the gallery's tour the working set is ~108–115 MB on Stocks, ~230 MB from the Canvas page, ~320–340 MB from the
Text View page and ~390–405 MB once Web and video has opened WebView2 (whose pages run in WebView2's own processes),
with what it caches on purpose (decoded images, bounded at 128 MB; the Text View page's documents).

### App size

The hello world apps made by `nsh init` with each template, as `nsh package --target windows` builds them for x86_64
(the Rust runners with link-time optimization and stripped, as on Linux). The executable is the app's `<Name>.exe`;
the zip is the `.zip` written beside its directory:

<div class="data-table">

| App | Written in | Executable | Zip |
|---|---|---|---|
| Hello world (`--template rust`) | Rust | 15.0 MB | 6.7 MB |
| Hello world (`--template ts`) | TSX, on QuickJS | 28.6 MB | 12.4 MB |
| Hello world (`--template mixed`) | TSX and a Rust crate | 26.3 MB | 11.5 MB |

</div>

What makes these numbers:

- **Frames only for changes, drawn only where they changed**: the compositor-paced ticker runs while a native
  animation, a transition or a frame callback runs. A frame draws the areas of the views that changed (where they
  were and where they are), over the pixels the window keeps, and presents only those to the compositor (Stocks:
  ~34 views a frame).
- **Canvases record their animated part**: a drawing is recorded as Direct2D command lists, vector and sharp at any
  scale. When an animated value changes, only the operations from the first one that reads an animated value on are
  recorded again; what comes before is kept (Stocks: ~26 ms of recording a second for 22 pulsing sparklines and the
  chart).
- **Only what shows is drawn**: the children of a scroll view or a clipping view that lie out of sight are left out of
  the frame, and views with no content of their own draw no more than their background and border.

## iOS (UIKit)

Measured in the iOS simulator (an iPhone 18 Pro Max, on the MacBook Pro above), release builds, with the same tour
(`perf.py --target ios`: `nsh test --target ios --fps`, a finger's touches as UIKit gets them). The simulator presents
at 60 Hz; on an iPhone with a ProMotion screen NSH's display links run at the screen's 120 Hz (apps that `nsh package`
builds and the development host ask for it with `CADisableMinimumFrameDurationOnPhone`). The phases are *tick* (native
animations), *drain* (applying the engine's batches) and *scroll* (what follows a scroll view: lists, sticky cells,
bound values).

<div class="data-table">

| Page | Frames come from | FPS | Frame p95 | CPU |
|---|---|---|---|---|
| Home, scrolling | Scroll | 60 | 0.1 ms | 6% |
| Stocks | Live data, native loops | 60 | 0.3 ms | 22% |
| Stocks, scrolling | Live data, scroll | 60 | 0.3 ms | 25% |
| Photos, scrolling | Scroll | 60 | 1.2 ms | 6% |
| Lists, scrolling | Scroll | 60 | 1.1 ms | 8% |
| Scrolling, scrolling | Scroll | 60 | 0.1 ms | 7% |
| Navigation, scrolling | Scroll | 60 | 0.2 ms | 7% |
| Form, scrolling | Scroll | 60 | 0.3 ms | 7% |
| Gestures | Springs, a pulsing ring | 60 | 0.3 ms | 3% |
| Animations | Native loops | 60 | 0.7 ms | 6% |
| Canvas | Native loops | 60 | 0.4 ms | 16% |
| Styles | A swaying transform | 60 | 0.4 ms | 4% |
| Tailwind, scrolling | Scroll | 60 | 0.2 ms | 7% |
| Text, scrolling | Scroll | 60 | 0.1 ms | 7% |
| Text View, scrolling | Scroll | 60 | 0.1 ms | 6% |
| Images, scrolling | Scroll | 60 | 0.1 ms | 5% |
| Components, scrolling | Scroll | 60 | 0.2 ms | 6% |
| Overlays, scrolling | Scroll | 60 | 0.1 ms | 6% |
| Menus, scrolling | Scroll | 60 | 0.2 ms | 7% |
| Controls, scrolling | Scroll, transitions | 60 | 0.2 ms | 5% |
| Web and video, scrolling | Scroll | 60 | 0.1 ms | 8% |
| System | `requestAnimationFrame`, timers | 60 | 0.3 ms | 4% |
| Standard APIs, scrolling | Scroll | 60 | 0.1 ms | 7% |
| Storage, scrolling | Scroll | 60 | 0.1 ms | 8% |

</div>

*FPS* is the rate while something moves, as above: at the simulator's 60, every frame comes one refresh after the
last. Every page with nothing moving draws no frame and uses 1–2% CPU at rest. The process holds 40 MB on the
gallery's home page and ~180 MB after the whole tour (images cached on purpose, the Text View page's documents).

On an iPhone 17 Pro (ProMotion, 120 Hz), with the development host and one demo on the screen, the animated pages
draw every refresh:

<div class="data-table">

| Page | Frames come from | FPS | Frame p95 | Over one refresh | CPU | Memory |
|---|---|---|---|---|---|---|
| Stocks | Live data, native loops | 120 | 0.2–0.3 ms | 0% | 46–70% | 41–43 MB |
| Canvas | Native loops | 120 | 0.1 ms | 0% | 25–36% | 37–38 MB |
| Animations | Native loops | 120 | 0.2 ms | 0% | 3–11% | 37 MB |

</div>

Stocks commits 20 times a second (a tick every 50 ms), each in 1.5 ms of JS and 1.4 ms of the core on the engine
thread (p95 2.2 and 2.0 ms), which is busy 4–6% of the time.

## Measuring an app

To measure an app the same way, run its tests or steps with `--fps` and `-v` on `--target linux`, `macos`, `windows` or `ios`:

```sh
cargo build --release -p nsh-cli
python3 examples/gallery/tools/perf.py --target macos --only Stocks,Canvas   # the gallery, page by page
echo 'await app.wait(5000)' | nsh -v test App.tsx --target linux --fps        # any app
```

