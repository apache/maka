---
title: Native backend migration
description: Breaking changes when moving GPUI applications to AppKit, Direct2D, GTK and native terminal surfaces.
order: 15.5
group: platforms
---

# Migrating from GPUI to native backends

This branch removes the GPUI renderer and its dedicated embedding API. This is a breaking change, not a source-compatible backend switch.

## Standalone applications

Run `nsh run App.tsx` to select the current operating system’s native backend. Explicit desktop targets are `macos` (AppKit), `windows` (Win32/Direct2D) and `linux` (GTK 4/Pango). Use the same native target for `nsh test` and `nsh package`.

The old `--target gpui` spelling returns a retirement error with migration guidance. It never silently changes target. Default distributions no longer build or ship `nsh-gpui-host`.

## Embedding applications

The `nsh-platform-gpui` crate, GPUI `Entity<AppView>`/`Element` integration, GPUI-native component factories and GPUI embedding example are retired. There is no compatibility alias. Choose the native host API and adapt the parent application’s window, focus, input and component ownership:

- macOS: `nsh-platform-macos::AppView`, embedded in AppKit views.
- Windows: `nsh-platform-windows::AppView`, hosted in a Win32 window and drawn with Direct2D.
- Linux: `nsh-platform-linux::AppView`, embedded as a GTK widget.
- Character terminals: `nsh-platform-tui::AppView`, embedded in a Ratatui region.

Keep application code, engine configuration, HostChannel handlers, data directories and capabilities explicit when creating the new native view. A GPUI custom component must be reimplemented as a component for the selected toolkit; its old GPUI view cannot be passed to a native factory.

## Terminal pixels and behavior differences

The shared `nsh-terminal` crate owns pixel transport, terminal events and native surface contracts. AppKit and Direct2D provide the offscreen surfaces; Kitty/Sixel transport does not depend on GPUI.

- On Linux, the pixel terminal explicitly falls back to character rendering, including sessions without a graphical display. The GTK desktop still requires a graphical session.
- Windows offscreen capture rejects externally composed WebView/child-HWND content instead of returning a misleading blank capture.
- AppKit custom components with nested tracking areas are not guaranteed to support synthetic offscreen interaction. AVPlayer and backdrop/compositor capture have native limitations that still require real-machine validation.
- GTK window placement restores normal size and maximized/fullscreen state. Absolute coordinates and monitor placement belong to the desktop compositor.
- Native controls, text metrics, IME integration, focus and accessibility come from their respective operating systems. They are not promised to reproduce GPUI’s rendering or toolkit-specific behavior byte for byte.

## Tests and verification

Product desktop and pixel regression cases are retained on native macOS/Windows runners. GTK behavior runs under Xvfb; shared terminal protocol tests run independently of a display. Native jobs fail an empty test selection rather than counting unsupported Linux pixel execution as success.

Tests tied only to the removed GPUI Entity/Element implementation retire with that API. Shared application contracts remain in the engine/core suites, product native cases and platform-specific regressions. Input/focus/modal/navigation coverage is audited during migration; deleting the old renderer is not evidence that all native semantics are equivalent.

Cross-platform compilation and real-machine visual/input validation remain required. This guide does not assert that all three desktop implementations have passed those checks.
